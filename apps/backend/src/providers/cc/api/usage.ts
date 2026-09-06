/**
 * What the subscription has left, asked for directly.
 *
 * Until now this provider inferred headroom from the `anthropic-ratelimit-unified-*` headers on the
 * last response, and that reading is honest but thin: on a consumer subscription those headers
 * usually carry a status and nothing else, so `getQuotas` reported `unlimited: true` for a plan that
 * very much has a limit. The operator's real question — "how much of my five-hour window is gone?" —
 * had no answer in the dashboard at all.
 *
 * Anthropic answers it at `/api/oauth/usage`, in windows rather than request counts:
 *
 *   - `five_hour`   — the rolling session window everyone actually runs into.
 *   - `seven_day`   — the weekly cap.
 *   - `seven_day_<model>` — per-model weekly caps, which is how Opus can be exhausted while Sonnet
 *     is untouched. Reported separately because merging them would describe neither.
 *
 * Each window reports `utilization`, which is a percentage **used**, not remaining. Reading it the
 * other way round draws a full bar on an exhausted account, so the inversion happens once, here.
 *
 * ## Three protections around one endpoint, and why each is needed
 *
 * This is a metered endpoint that rate-limits independently of chat — a 429 here does not mean the
 * account cannot serve requests, only that the dashboard asked too often. The dashboard polls, every
 * open tab polls, and every account polls, so the naive version hammers it immediately.
 *
 *   - **TTL + single-flight** — one call per credential per five minutes, and concurrent callers share
 *     it. Quota moves in minutes; asking faster buys nothing.
 *   - **429 cooldown** — after a rate-limit, stop asking for three minutes and fall back to the legacy
 *     endpoint. Retrying into a 429 is how a soft limit becomes a hard one.
 *   - **Stale over error** — a failed read returns the last good snapshot rather than nothing. A
 *     quota bar that vanishes on a transient error reads as "no limit", which is the opposite of true.
 */

import { ANTHROPIC_VERSION, credentialKind, OAUTH_BETA } from '../auth/credential';
import { createSingleFlight } from '../auth/single-flight';
import { getClaudeCodeConfig } from '../config/provider-config';

/** Quota moves in minutes. Anything faster is polling for its own sake. */
const USAGE_TTL_MS = 5 * 60_000;

/** How long to leave the usage endpoint alone after it rate-limits us. */
const USAGE_429_COOLDOWN_MS = 3 * 60_000;

/** A dashboard read must not hold a page open. Shorter than a chat timeout by two orders of magnitude. */
const USAGE_TIMEOUT_MS = 10_000;

/**
 * One reported limit window.
 *
 * `remainingFraction` is 0–1 to match `IProviderQuota`, converted from Anthropic's percentage-used at
 * the single point where the meaning flips.
 */
export interface UsageWindow {
  /** Operator-facing name, e.g. `session (5h)` or `weekly opus (7d)`. */
  label: string;
  /** 0–100, percentage consumed — kept as reported so the dashboard can show "87% used" verbatim. */
  utilizationPercent: number;
  /** 0–1 headroom. `1 - utilization/100`, clamped. */
  remainingFraction: number;
  /** Epoch ms when this window rolls over, when the server said. */
  resetsAt?: number;
}

export interface ClaudeUsageSnapshot {
  plan: string;
  organization?: string;
  /** Whatever the server reported about pay-as-you-go overflow. Passed through, not interpreted. */
  extraUsage?: unknown;
  windows: UsageWindow[];
  /** Why there are no windows, when the endpoint answered but had nothing to report. */
  note?: string;
  /** When this reading was taken. Lets a caller tell a fresh snapshot from a stale one it was handed. */
  observedAt: number;
}

/**
 * Model keys as Anthropic reports them, and what an operator calls them.
 *
 * Only the ones that do not survive a mechanical `seven_day_` strip. Everything else — `opus`,
 * `sonnet`, `haiku` — passes through as itself, so a model added upstream shows up without a change
 * here rather than being silently dropped.
 */
const MODEL_DISPLAY_NAMES: Record<string, string> = {
  fable_5_1: 'fable',
  fable_5: 'fable',
};

/** Per-credential 429 cooldown. Keyed by token because the limit is the token's, not the account's. */
const usageCooldown = new Map<string, number>();

/** Concurrency and freshness in one, keyed by credential. See `single-flight.ts`. */
const usageFlight = createSingleFlight<ClaudeUsageSnapshot | null>(USAGE_TTL_MS);

/** The last reading that actually worked, per credential — what a failed read falls back to. */
const lastGood = new Map<string, ClaudeUsageSnapshot>();

/** Test seam, and the reset an operator's "refresh now" needs to bypass the TTL. */
export function resetUsageCache(): void {
  usageFlight.clear();
  lastGood.clear();
  usageCooldown.clear();
}

function endpoints() {
  const base = getClaudeCodeConfig().baseUrl.replace(/\/$/, '');
  return {
    /** The consumer-subscription window report. The one that answers the real question. */
    oauthUsage: `${base}/api/oauth/usage`,
    /** Org plan and identity, for the API-key path. */
    settings: `${base}/v1/settings`,
    /** Org-level consumption. Requires admin scope, so most credentials get a 403 here. */
    orgUsage: (orgId: string) => `${base}/v1/organizations/${encodeURIComponent(orgId)}/usage`,
  };
}

/**
 * Headroom for one credential.
 *
 * Returns `null` rather than throwing when the reading cannot be taken. A quota panel is
 * supplementary — it must never be the reason a dashboard request fails, and a provider that throws
 * from `getQuotas` takes the whole page down over an endpoint that has no bearing on serving traffic.
 *
 * @param force Skip the TTL. For an explicit operator refresh, not for polling.
 */
export async function getUsage(
  credential: string,
  options: { force?: boolean } = {},
): Promise<ClaudeUsageSnapshot | null> {
  const token = credential.trim();
  if (!token) return null;

  if (options.force) usageFlight.forget(token);

  return usageFlight.run(token, async () => {
    const snapshot = await readUsage(token);
    if (snapshot) {
      lastGood.set(token, snapshot);
      return snapshot;
    }
    // Stale beats nothing: an empty quota panel reads as "no limit", which is the opposite of what a
    // failed read means.
    return lastGood.get(token) ?? null;
  });
}

async function readUsage(token: string): Promise<ClaudeUsageSnapshot | null> {
  const { oauthUsage } = endpoints();

  // An API key has no consumer subscription behind it, so the OAuth window endpoint has nothing to
  // say about it. Going straight to the org endpoints saves a guaranteed 401.
  if (credentialKind(token) === 'api-key') return readLegacyUsage(token);

  const coolingUntil = usageCooldown.get(token);
  if (coolingUntil !== undefined && coolingUntil > Date.now()) return readLegacyUsage(token);

  try {
    const res = await fetchWithTimeout(oauthUsage, {
      authorization: `Bearer ${token}`,
      'anthropic-beta': OAUTH_BETA,
      'anthropic-version': ANTHROPIC_VERSION,
    });

    if (res.ok) return parseOAuthUsage(await res.json());

    if (res.status === 429) {
      usageCooldown.set(token, Date.now() + USAGE_429_COOLDOWN_MS);
      console.warn(
        `[cc] usage endpoint rate limited; not asking again for ${USAGE_429_COOLDOWN_MS / 1000}s`,
      );
    }

    return await readLegacyUsage(token);
  } catch (error) {
    console.warn(`[cc] could not read usage: ${String(error).slice(0, 200)}`);
    return null;
  }
}

/**
 * Turn the window report into quota rows.
 *
 * Windows the server did not report are **left out**, never defaulted to zero. A row invented from a
 * silence is a reading the operator will act on, and "0% used" on a window that was never reported is
 * the most reassuring possible way to be wrong.
 */
function parseOAuthUsage(data: any): ClaudeUsageSnapshot {
  const windows: UsageWindow[] = [];

  const add = (label: string, window: unknown) => {
    if (!window || typeof window !== 'object') return;
    const used = (window as { utilization?: unknown }).utilization;
    if (typeof used !== 'number' || !Number.isFinite(used)) return;

    const resetsAt = parseResetTime((window as { resets_at?: unknown }).resets_at);
    windows.push({
      label,
      utilizationPercent: used,
      // Clamped: the server has been seen to report over 100 on an exhausted window, and a negative
      // fraction draws a bar backwards.
      remainingFraction: Math.max(0, Math.min(1, 1 - used / 100)),
      ...(resetsAt !== undefined ? { resetsAt } : {}),
    });
  };

  add('session (5h)', data?.five_hour);
  add('weekly (7d)', data?.seven_day);

  // Per-model weekly windows. Read by prefix rather than from a fixed list so a model Anthropic adds
  // next month appears on the dashboard without a code change.
  for (const [key, value] of Object.entries(data ?? {})) {
    if (!key.startsWith('seven_day_') || key === 'seven_day') continue;
    const raw = key.slice('seven_day_'.length);
    add(`weekly ${MODEL_DISPLAY_NAMES[raw] ?? raw} (7d)`, value);
  }

  return {
    plan: 'Claude Code',
    ...(data?.extra_usage !== undefined && data?.extra_usage !== null
      ? { extraUsage: data.extra_usage }
      : {}),
    windows,
    ...(windows.length === 0 ? { note: 'the plan reported no limit windows' } : {}),
    observedAt: Date.now(),
  };
}

/**
 * The org path, for an API key or an admin credential.
 *
 * Two calls, and the second usually 403s: org usage needs an admin scope that an ordinary key does
 * not carry. That is not an error worth logging loudly — it is the expected answer for most
 * credentials — so it degrades to a plan name and a note rather than to nothing.
 */
async function readLegacyUsage(token: string): Promise<ClaudeUsageSnapshot | null> {
  const { settings, orgUsage } = endpoints();
  // Whichever header this credential belongs on. An API key on `Authorization` is a 401 that reads
  // exactly like an expired token — see `auth/credential.ts`.
  const auth: Record<string, string> =
    credentialKind(token) === 'api-key'
      ? { 'x-api-key': token, 'anthropic-version': ANTHROPIC_VERSION }
      : { authorization: `Bearer ${token}`, 'anthropic-version': ANTHROPIC_VERSION };

  try {
    const res = await fetchWithTimeout(settings, auth);
    if (!res.ok) return null;

    const settingsData = (await res.json()) as {
      plan?: string;
      organization_id?: string;
      organization_name?: string;
    };

    const base: ClaudeUsageSnapshot = {
      plan: settingsData.plan || 'unknown',
      ...(settingsData.organization_name ? { organization: settingsData.organization_name } : {}),
      windows: [],
      observedAt: Date.now(),
    };

    if (!settingsData.organization_id) {
      return { ...base, note: 'usage details require admin access' };
    }

    const usageRes = await fetchWithTimeout(orgUsage(settingsData.organization_id), auth);
    if (!usageRes.ok) return { ...base, note: 'usage details require admin access' };

    // The org endpoint reports consumption, not the utilization windows the OAuth one does — there is
    // no percentage to derive, so it is carried as `extraUsage` for display rather than reshaped into
    // a bar that would imply a cap nobody reported.
    return { ...base, extraUsage: await usageRes.json(), note: 'organization usage, not a plan cap' };
  } catch (error) {
    console.warn(`[cc] could not read org usage: ${String(error).slice(0, 200)}`);
    return null;
  }
}

/**
 * Epoch ms from whatever the server put in `resets_at`.
 *
 * Seen as an RFC 3339 string, as a Unix seconds number and as a numeric string. The `1e12` threshold
 * is what separates seconds from milliseconds: any plausible current timestamp in seconds is below
 * it, and in milliseconds above it.
 */
function parseResetTime(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined;
    return value < 1e12 ? value * 1000 : value;
  }

  if (typeof value === 'string') {
    if (/^\d+$/.test(value)) {
      const numeric = Number(value);
      return numeric < 1e12 ? numeric * 1000 : numeric;
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

async function fetchWithTimeout(url: string, headers: Record<string, string>): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), USAGE_TIMEOUT_MS);
  try {
    return await fetch(url, { method: 'GET', headers, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}
