/**
 * Kiro usage limits, read from CodeWhisperer's `GetUsageLimits`.
 *
 * Kiro meters in credits per resource type (agentic requests today), on a monthly cycle, with an
 * optional free-trial allowance beside the paid one. Everything specific to that lives here; the
 * rest of the gateway only sees `IProviderQuota`.
 */

import type { IProviderQuota } from '@/core/interfaces';
import {
  KIRO_USAGE_LIMITS_PATH,
  codewhispererHost,
  qHost,
  regionFromProfileArn,
  resolveProfileArn,
} from '../upstream/endpoints';
import { authHeaders } from '../upstream/headers';
import type { KiroAccount } from './types';

/** Credits move slowly and every read costs a request per account; the dashboard reuses this. */
const CACHE_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20_000;

interface UsageFigures {
  currentUsageWithPrecision?: number;
  usageLimitWithPrecision?: number;
  currentUsage?: number;
  usageLimit?: number;
}

interface UsageBreakdown extends UsageFigures {
  resourceType?: string;
  displayName?: string;
  unit?: string;
  freeTrialInfo?: UsageFigures & { freeTrialExpiry?: number | string; freeTrialStatus?: string };
}

export interface KiroUsageLimits {
  usageBreakdownList?: UsageBreakdown[];
  nextDateReset?: number | string;
  resetDate?: number | string;
  subscriptionInfo?: { subscriptionTitle?: string; type?: string };
  userInfo?: { email?: string; userId?: string };
}

/** Epoch seconds, epoch ms, numeric strings and ISO strings all appear; normalise to ms. */
export function parseResetTime(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  if (typeof value === 'string') {
    if (/^\d+(\.\d+)?$/.test(value)) return parseResetTime(Number(value));
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? ms : undefined;
  }
  return undefined;
}

export function formatResetIn(resetAt: number | undefined, now = Date.now()): string | undefined {
  if (resetAt === undefined) return undefined;
  const remaining = Math.max(0, resetAt - now);
  const days = Math.floor(remaining / 86_400_000);
  const hours = Math.floor((remaining % 86_400_000) / 3_600_000);
  const minutes = Math.floor((remaining % 3_600_000) / 60_000);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function figures(source: UsageFigures): { used: number; limit: number } | null {
  const used = source.currentUsageWithPrecision ?? source.currentUsage;
  const limit = source.usageLimitWithPrecision ?? source.usageLimit;
  if (typeof used !== 'number' || typeof limit !== 'number') return null;
  return { used, limit };
}

function round(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function labelFor(resourceType: string): string {
  const words = resourceType.toLowerCase().split('_').filter(Boolean);
  return words.map((word, index) => (index === 0 ? word[0]!.toUpperCase() + word.slice(1) : word)).join(' ');
}

/**
 * One account's limits as normalised quotas.
 *
 * A breakdown without both figures is skipped rather than shown as empty — "the API said nothing"
 * is not "the allowance is spent". A zero limit is reported with no fraction arithmetic, for the
 * same reason Copilot's unlimited seats are: `0 / 0` is not a percentage.
 */
export function mapUsageLimits(data: KiroUsageLimits, now = Date.now()): IProviderQuota[] {
  const resetIn = formatResetIn(parseResetTime(data.nextDateReset ?? data.resetDate), now);
  const quotas: IProviderQuota[] = [];

  for (const breakdown of data.usageBreakdownList ?? []) {
    const key = (breakdown.resourceType || 'unknown').toLowerCase();
    const unit = breakdown.unit?.toLowerCase() || 'credits';
    const paid = figures(breakdown);
    if (paid) {
      quotas.push({
        id: key,
        label: breakdown.displayName || labelFor(key),
        remainingFraction: paid.limit > 0 ? Math.max(0, Math.min(1, (paid.limit - paid.used) / paid.limit)) : 0,
        used: round(paid.used),
        ...(paid.limit > 0 ? { limit: round(paid.limit) } : {}),
        unit,
        ...(resetIn ? { resetIn } : {}),
      });
    }

    const trial = breakdown.freeTrialInfo ? figures(breakdown.freeTrialInfo) : null;
    if (trial && breakdown.freeTrialInfo?.freeTrialStatus !== 'EXPIRED') {
      const trialReset = formatResetIn(parseResetTime(breakdown.freeTrialInfo?.freeTrialExpiry), now) ?? resetIn;
      quotas.push({
        id: `${key}_freetrial`,
        label: `${breakdown.displayName || labelFor(key)} (free trial)`,
        remainingFraction: trial.limit > 0 ? Math.max(0, Math.min(1, (trial.limit - trial.used) / trial.limit)) : 0,
        used: round(trial.used),
        ...(trial.limit > 0 ? { limit: round(trial.limit) } : {}),
        unit,
        ...(trialReset ? { resetIn: trialReset } : {}),
      });
    }
  }
  return quotas;
}

/**
 * Combine per-account quotas into one figure per resource.
 *
 * Kiro credits belong to each account's own subscription, so several accounts are several
 * allowances: the fraction is averaged — that is what rotation will find — and usage is summed.
 * A summed usage is not comparable to one account's limit, so the limit is only kept for a pool of
 * one. The text fields describe the account closest to running out.
 */
export function mergeAccountQuotas(perAccount: IProviderQuota[][]): IProviderQuota[] {
  const merged = new Map<string, { sum: number; count: number; used: number; sample: IProviderQuota }>();
  for (const quotas of perAccount) {
    for (const quota of quotas) {
      const used = Number(quota.used ?? 0);
      const entry = merged.get(quota.id);
      if (!entry) {
        merged.set(quota.id, { sum: quota.remainingFraction, count: 1, used: Number.isFinite(used) ? used : 0, sample: quota });
        continue;
      }
      entry.sum += quota.remainingFraction;
      entry.count += 1;
      entry.used += Number.isFinite(used) ? used : 0;
      if (quota.remainingFraction < entry.sample.remainingFraction) entry.sample = quota;
    }
  }
  return [...merged.values()].map(({ sum, count, used, sample }) => {
    const { limit, ...rest } = sample;
    return {
      ...rest,
      remainingFraction: sum / count,
      used: round(used),
      ...(count === 1 && limit !== undefined ? { limit } : {}),
    };
  });
}

type UsageAccount = Pick<KiroAccount, 'authMethod' | 'accessToken' | 'profileArn' | 'region'>;

/**
 * Fetch one account's raw limits. Three known shapes of the same call are tried in order; the
 * first to answer wins. Throws only when none do.
 */
export async function fetchUsageLimits(account: UsageAccount): Promise<KiroUsageLimits> {
  const region = regionFromProfileArn(account.profileArn) ?? account.region;
  const profileArn = resolveProfileArn(account);
  const auth = authHeaders(account);
  const getParams = new URLSearchParams({ isEmailRequired: 'true', origin: 'AI_EDITOR', resourceType: 'AGENTIC_REQUEST' });
  if (profileArn) getParams.set('profileArn', profileArn);

  const attempts: Array<{ name: string; run: () => Promise<Response> }> = [
    {
      name: 'codewhisperer-get',
      run: () =>
        fetch(`${codewhispererHost(region)}${KIRO_USAGE_LIMITS_PATH}?${getParams}`, {
          headers: {
            Accept: 'application/json',
            'x-amz-user-agent': 'aws-sdk-js/1.0.0 KiroIDE',
            'user-agent': 'aws-sdk-js/1.0.0 KiroIDE',
            ...auth,
          },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        }),
    },
    {
      name: 'codewhisperer-post',
      run: () =>
        fetch(codewhispererHost(region), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-amz-json-1.0',
            'x-amz-target': 'AmazonCodeWhispererService.GetUsageLimits',
            Accept: 'application/json',
            ...auth,
          },
          body: JSON.stringify({ origin: 'AI_EDITOR', resourceType: 'AGENTIC_REQUEST', ...(profileArn ? { profileArn } : {}) }),
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        }),
    },
    {
      name: 'q-get',
      run: () =>
        fetch(`${qHost(region)}${KIRO_USAGE_LIMITS_PATH}?${getParams}`, {
          headers: { Accept: 'application/json', ...auth },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        }),
    },
  ];

  const failures: string[] = [];
  for (const attempt of attempts) {
    try {
      const response = await attempt.run();
      if (response.ok) return (await response.json()) as KiroUsageLimits;
      failures.push(`${attempt.name}:${response.status}`);
      await response.body?.cancel();
    } catch (error) {
      failures.push(`${attempt.name}:${(error as Error).message}`);
    }
  }
  throw new Error(`GetUsageLimits failed (${failures.join(', ')})`);
}

const cache = new Map<string, { fetchedAt: number; quotas: IProviderQuota[] }>();

export function invalidateQuotaCache(accountId?: string): void {
  if (accountId) cache.delete(accountId);
  else cache.clear();
}

async function accountQuotas(account: KiroAccount): Promise<IProviderQuota[]> {
  const cached = cache.get(account.id);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.quotas;
  const quotas = mapUsageLimits(await fetchUsageLimits(account));
  cache.set(account.id, { fetchedAt: Date.now(), quotas });
  return quotas;
}

/**
 * Quota for the whole pool. An account that fails to answer — or is invalidated — contributes
 * nothing rather than a zero, so one expired token cannot make a healthy pool look exhausted.
 */
export async function getPoolQuotas(accounts: KiroAccount[]): Promise<IProviderQuota[]> {
  const live = accounts.filter((account) => !account.invalidatedAt);
  const settled = await Promise.allSettled(live.map(accountQuotas));
  const perAccount: IProviderQuota[][] = [];
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') perAccount.push(result.value);
    else console.warn(`[kiro] could not read quota for ${live[index]?.label}: ${(result.reason as Error)?.message}`);
  });
  return mergeAccountQuotas(perAccount);
}
