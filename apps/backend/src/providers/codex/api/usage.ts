/**
 * Codex usage and quota reporting — wham API.
 *
 * Handles: usage fetch, review quota, spark quota, primary/secondary windows.
 */

import type { IProviderQuota } from '@/core/interfaces';

const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

const USAGE_TIMEOUT_MS = 10_000;

function toFiniteNumber(value: any, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseResetTime(value: any): number | undefined {
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


interface QuotaWindow {
  used: number;
  total: number;
  remaining: number;
  resetAt?: number;
  unlimited: boolean;
}

function formatCodexWindow(window: any): QuotaWindow {
  const used = Math.max(0, Math.min(100, toFiniteNumber(window?.used_percent ?? window?.percent_used, 0)));
  return {
    used,
    total: 100,
    remaining: Math.max(0, 100 - used),
    resetAt: parseResetTime(window?.reset_at ?? window?.resets_at ?? window?.resetAt ?? null),
    unlimited: false,
  };
}

function getRateLimitBody(snapshot: any): any | null {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  return snapshot.rate_limit && typeof snapshot.rate_limit === 'object'
    ? snapshot.rate_limit
    : snapshot;
}

function appendQuotaWindows(
  quotas: Record<string, QuotaWindow>,
  prefix: string,
  snapshot: any,
): boolean {
  const rateLimit = getRateLimitBody(snapshot);
  if (!rateLimit) return false;

  const primary = rateLimit.primary_window || rateLimit.primary || snapshot?.primary_window || snapshot?.primary;
  const secondary = rateLimit.secondary_window || rateLimit.secondary || snapshot?.secondary_window || snapshot?.secondary;
  let added = false;

  if (primary) {
    quotas[prefix ? `${prefix}_session` : 'session'] = formatCodexWindow(primary);
    added = true;
  }
  if (secondary) {
    quotas[prefix ? `${prefix}_weekly` : 'weekly'] = formatCodexWindow(secondary);
    added = true;
  }

  return added;
}

function getReviewRateLimit(data: any): any | null {
  if (data.code_review_rate_limit || data.review_rate_limit) {
    return data.code_review_rate_limit || data.review_rate_limit;
  }

  const byLimitId = data.rate_limits_by_limit_id;
  if (byLimitId && typeof byLimitId === 'object' && !Array.isArray(byLimitId)) {
    return byLimitId.code_review || byLimitId.codex_review || byLimitId.review || null;
  }

  const additional = Array.isArray(data.additional_rate_limits) ? data.additional_rate_limits : [];
  return additional.find((entry: any) => {
    const id = String(entry?.limit_name || entry?.metered_feature || entry?.id || '').toLowerCase();
    return id === 'code_review' || id === 'codex_review' || id === 'review' || id.includes('review');
  }) || null;
}

function getSparkRateLimit(data: any): any | null {
  if (data.spark_rate_limit || data.gpt_5_3_codex_spark_rate_limit) {
    return data.spark_rate_limit || data.gpt_5_3_codex_spark_rate_limit;
  }

  const byLimitId = data.rate_limits_by_limit_id;
  if (byLimitId && typeof byLimitId === 'object' && !Array.isArray(byLimitId)) {
    return byLimitId['gpt-5.3-codex-spark'] || byLimitId.gpt_5_3_codex_spark || byLimitId.spark || null;
  }

  const additional = Array.isArray(data.additional_rate_limits) ? data.additional_rate_limits : [];
  return additional.find((entry: any) => {
    const id = String(entry?.limit_name || entry?.metered_feature || entry?.id || '').toLowerCase();
    return id.includes('spark') || id.includes('5.3-codex-spark');
  }) || null;
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

export interface CodexUsageSnapshot {
  plan: string;
  limitReached: boolean;
  reviewLimitReached: boolean;
  sparkLimitReached: boolean;
  resetCredits: { availableCount: number };
  quotas: Record<string, QuotaWindow>;
}

/**
 * Fetch Codex usage from the wham API.
 */
export async function getCodexUsage(accessToken: string): Promise<CodexUsageSnapshot | null> {
  try {
    const response = await fetchWithTimeout(CODEX_USAGE_URL, {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json',
    });

    if (!response.ok) {
      console.warn(`[codex] usage API returned ${response.status}`);
      return null;
    }

    const data = await response.json() as any;
    const normalRateLimit = data.rate_limit || data.rate_limits || data.rate_limits_by_limit_id?.codex || {};
    const reviewRateLimit = getReviewRateLimit(data);
    const sparkRateLimit = getSparkRateLimit(data);
    const availableResetCredits = Math.max(0, toFiniteNumber(data.rate_limit_reset_credits?.available_count, 0));
    const quotas: Record<string, QuotaWindow> = {};

    appendQuotaWindows(quotas, '', normalRateLimit);
    appendQuotaWindows(quotas, 'review', reviewRateLimit);
    appendQuotaWindows(quotas, 'spark', sparkRateLimit);

    return {
      plan: data.plan_type || data.summary?.plan || 'unknown',
      limitReached: getRateLimitBody(normalRateLimit)?.limit_reached || false,
      reviewLimitReached: getRateLimitBody(reviewRateLimit)?.limit_reached || false,
      sparkLimitReached: getRateLimitBody(sparkRateLimit)?.limit_reached || false,
      resetCredits: { availableCount: availableResetCredits },
      quotas,
    };
  } catch (error) {
    console.warn(`[codex] could not read usage: ${String(error).slice(0, 200)}`);
    return null;
  }
}

/**
 * Convert a CodexUsageSnapshot into IProviderQuota[] for the dashboard.
 */
export function usageToQuotas(accountId: string, accountLabel: string, usage: CodexUsageSnapshot): IProviderQuota[] {
  const quotas: IProviderQuota[] = [];

  for (const [key, window] of Object.entries(usage.quotas)) {
    const remaining = Math.max(0, Math.min(1, window.remaining / 100));
    quotas.push({
      id: `${accountId}:${key}`,
      label: `${accountLabel} — ${key}`,
      remainingFraction: remaining,
      used: `${Math.round(window.used)}%`,
      limit: '100%',
      unit: 'of window used',
      ...(window.resetAt ? { resetIn: formatResetIn(window.resetAt) } : {}),
    });
  }

  return quotas;
}

function formatResetIn(at: number): string {
  const ms = at - Date.now();
  if (ms <= 0) return 'now';
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}
