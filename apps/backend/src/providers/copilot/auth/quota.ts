import type { IProviderQuota } from '@/core/interfaces';
import type { CopilotAccount } from './types';

/**
 * Copilot usage limits, read from `copilot_internal/user`.
 *
 * GitHub reports quota per *entitlement type* — chat, code completions and
 * premium interactions — on a monthly cycle, which is nothing like Antigravity's
 * per-model rolling windows. Everything specific to that lives in this file;
 * the rest of the gateway only sees `IProviderQuota`.
 */

const QUOTA_URL = 'https://api.github.com/copilot_internal/user';

/**
 * Quota moves slowly (a monthly cycle) and every read costs a GitHub request
 * per account, so a snapshot is reused for this long. Opening the dashboard
 * repeatedly must not turn into upstream traffic.
 */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** One entitlement's figures, as GitHub returns them. */
interface QuotaSnapshot {
  unlimited?: boolean;
  has_quota?: boolean;
  percent_remaining?: number;
  entitlement?: number;
  remaining?: number;
  credits_used?: number;
  overage_count?: number;
  overage_permitted?: boolean;
}

interface CopilotUserResponse {
  copilot_plan?: string;
  quota_reset_date?: string;
  quota_reset_date_utc?: string;
  quota_snapshots?: Record<string, QuotaSnapshot>;
}

/** Labels for the entitlements GitHub ships today. */
const LABELS: Record<string, string> = {
  chat: 'Chat',
  completions: 'Code completions',
  premium_interactions: 'Premium requests',
};

/** Turn an unknown snapshot key into something presentable. */
function labelFor(key: string): string {
  return (
    LABELS[key] ??
    key.replace(/_/g, ' ').replace(/^./, (character) => character.toUpperCase())
  );
}

/**
 * Render a future instant as coarse time-to-go. Copilot's cycle is monthly, so
 * days lead; below a day it falls back to hours and minutes.
 */
export function formatResetIn(resetDate: string | undefined, now = Date.now()): string | undefined {
  if (!resetDate) {
    return undefined;
  }

  const target = new Date(resetDate).getTime();
  if (Number.isNaN(target)) {
    return undefined;
  }

  const remaining = Math.max(0, target - now);
  const days = Math.floor(remaining / 86_400_000);
  const hours = Math.floor((remaining % 86_400_000) / 3_600_000);
  const minutes = Math.floor((remaining % 3_600_000) / 60_000);

  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

/**
 * Headroom left, 0–1.
 *
 * `percent_remaining` is authoritative and is what GitHub itself displays.
 * The entitlement arithmetic is only a fallback, and is skipped when the
 * entitlement is zero — on an unlimited plan every count is 0, and dividing
 * them yields NaN rather than "empty".
 */
function remainingFraction(snapshot: QuotaSnapshot): number {
  if (snapshot.unlimited) {
    return 1;
  }

  if (typeof snapshot.percent_remaining === 'number') {
    return Math.max(0, Math.min(1, snapshot.percent_remaining / 100));
  }

  const entitlement = snapshot.entitlement ?? 0;
  if (entitlement > 0) {
    return Math.max(0, Math.min(1, (snapshot.remaining ?? 0) / entitlement));
  }

  return 1;
}

/**
 * Convert one account's `copilot_internal/user` payload into normalised quotas.
 */
export function mapUserQuotas(data: CopilotUserResponse): IProviderQuota[] {
  const snapshots = data.quota_snapshots ?? {};
  const resetIn = formatResetIn(data.quota_reset_date_utc ?? data.quota_reset_date);

  return Object.entries(snapshots)
    // An entitlement the plan does not include carries no figures worth showing.
    .filter(([, snapshot]) => snapshot.has_quota !== false)
    .map(([key, snapshot]) => {
      const unlimited = snapshot.unlimited === true;
      const entitlement = snapshot.entitlement ?? 0;

      // On a capped plan, usage is what the entitlement no longer covers. On an
      // unlimited one there is nothing to subtract from, so consumption is
      // reported directly and no limit is claimed.
      const used = unlimited
        ? snapshot.credits_used ?? 0
        : Math.max(0, entitlement - (snapshot.remaining ?? 0));

      return {
        id: key,
        label: labelFor(key),
        remainingFraction: remainingFraction(snapshot),
        unlimited,
        used: String(used),
        limit: unlimited || entitlement === 0 ? undefined : String(entitlement),
        unit: key === 'premium_interactions' ? 'premium requests' : 'requests',
        resetIn,
      } satisfies IProviderQuota;
    });
}

/**
 * Combine per-account quotas into one figure per entitlement.
 *
 * Copilot quota belongs to a seat, so several accounts are several independent
 * allowances. The fraction is averaged — that is what rotation across the pool
 * will actually find — while usage is summed, since it is the pool's total
 * consumption. An entitlement is only unlimited when every seat says so.
 */
export function mergeAccountQuotas(perAccount: IProviderQuota[][]): IProviderQuota[] {
  const merged = new Map<string, { sum: number; count: number; used: number; sample: IProviderQuota; allUnlimited: boolean }>();

  for (const quotas of perAccount) {
    for (const quota of quotas) {
      const used = Number(quota.used ?? 0);
      const existing = merged.get(quota.id);

      if (!existing) {
        merged.set(quota.id, {
          sum: quota.remainingFraction,
          count: 1,
          used: Number.isFinite(used) ? used : 0,
          sample: quota,
          allUnlimited: quota.unlimited === true,
        });
        continue;
      }

      existing.sum += quota.remainingFraction;
      existing.count += 1;
      existing.used += Number.isFinite(used) ? used : 0;
      existing.allUnlimited &&= quota.unlimited === true;
      // Describe the seat closest to running out, not an arbitrary one.
      if (quota.remainingFraction < existing.sample.remainingFraction) {
        existing.sample = quota;
      }
    }
  }

  return Array.from(merged.values()).map((entry) => ({
    ...entry.sample,
    remainingFraction: entry.sum / entry.count,
    unlimited: entry.allUnlimited,
    used: String(entry.used),
    // A summed usage against one seat's entitlement would not be comparable.
    limit: entry.count === 1 ? entry.sample.limit : undefined,
  }));
}

interface CacheEntry {
  fetchedAt: number;
  quotas: IProviderQuota[];
}

const cache = new Map<string, CacheEntry>();

/** Drop a cached snapshot, e.g. when an account is removed or re-authed. */
export function invalidateQuotaCache(accountId?: string): void {
  if (accountId) {
    cache.delete(accountId);
  } else {
    cache.clear();
  }
}

async function fetchAccountQuotas(account: CopilotAccount): Promise<IProviderQuota[]> {
  const cached = cache.get(account.id);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.quotas;
  }

  const response = await fetch(QUOTA_URL, {
    headers: {
      Authorization: `Bearer ${account.personalToken}`,
      'User-Agent': 'GithubCopilot/1.250.0',
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`copilot_internal/user returned ${response.status}`);
  }

  const quotas = mapUserQuotas((await response.json()) as CopilotUserResponse);
  cache.set(account.id, { fetchedAt: Date.now(), quotas });
  return quotas;
}

/**
 * Quota for the whole account pool.
 *
 * A seat that fails to answer is skipped rather than failing the request: one
 * expired token should not blank out the panel for every other account.
 */
export async function getPoolQuotas(accounts: CopilotAccount[]): Promise<IProviderQuota[]> {
  const settled = await Promise.allSettled(accounts.map((account) => fetchAccountQuotas(account)));

  const perAccount: IProviderQuota[][] = [];
  for (const [index, result] of settled.entries()) {
    if (result.status === 'fulfilled') {
      perAccount.push(result.value);
    } else {
      console.warn(
        `[Copilot] Could not read quota for ${accounts[index]?.id}:`,
        result.reason instanceof Error ? result.reason.message : result.reason,
      );
    }
  }

  return mergeAccountQuotas(perAccount);
}
