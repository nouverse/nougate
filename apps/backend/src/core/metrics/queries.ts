import { and, asc, desc, eq, gte, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import { getDb, t, timeBucket } from '@/core/db';
import { tokenMetricsLogger } from '@/core/metrics/logger';
import { retentionDays } from '@/core/metrics/retention';

export type Lookback = '24h' | '7d' | '14d' | '30d' | '60d' | '90d';

const LOOKBACK_DAYS: Record<Lookback, number> = {
  '24h': 1,
  '7d': 7,
  '14d': 14,
  '30d': 30,
  '60d': 60,
  '90d': 90,
};

/** Filter value for keyless traffic — historical rows from before keys were required. */
export const NO_API_KEY = 'none';

export interface UsageFilters {
  lookback: Lookback;
  clientId?: string;
  provider?: string;
  /** Gateway API key ID, or 'none' for traffic recorded without one. */
  apiKeyId?: string;
}

export interface UsagePoint {
  period: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  tokensSaved: number;
  totalCost: number;
  costSaved: number;
}

export interface ModelStat {
  fullModelName: string;
  provider: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  totalCost: number;
}

export interface ApiKeyStat {
  apiKeyId: string;
  /** The key's name, or a placeholder when it was deleted or never used. */
  name: string;
  revoked: boolean;
  requests: number;
  totalTokens: number;
  totalCost: number;
}

/** What one compression engine saved over the selected window. */
export interface CompressionEngineStat {
  engine: string;
  /** Requests this engine ran on. */
  requests: number;
  tokensSaved: number;
  /** Share of all compression savings in the window, 0–100. */
  sharePercent: number;
}

export interface CompressionBreakdown {
  engines: CompressionEngineStat[];
  tokensSaved: number;
  /**
   * False when the window is served from the daily rollups, which do not carry
   * per-engine detail. The dashboard says so instead of showing an empty chart.
   */
  available: boolean;
}

export interface GroupStat {
  requests: number;
  totalTokens: number;
  totalCost: number;
}

export interface UsageSummary {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  tokensSaved: number;
  /**
   * Input tokens that were read from the provider's prompt cache.
   *
   * Part of `inputTokens`, not additional to it — a cache read is still an input token, it just costs
   * a tenth of one. Reported separately because the share of it is the number that says whether
   * caching is working at all.
   */
  cachedInputTokens: number;
  totalCost: number;
  /** What compression saved. */
  costSaved: number;
  /** What the prompt cache saved. A second engine, so a second number. */
  cacheCostSaved: number;
  /** What this window would have cost with neither engine. */
  originalCost: number;
  savingsPercent: number;
  avgDurationMs: number;
  pendingWrites: number;
}

export function normalizeLookback(value: string | null | undefined): Lookback {
  return value && value in LOOKBACK_DAYS ? (value as Lookback) : '24h';
}

function windowStartMs(lookback: Lookback): number {
  return Date.now() - LOOKBACK_DAYS[lookback] * 24 * 60 * 60 * 1000;
}

function windowStartDate(lookback: Lookback): string {
  return new Date(windowStartMs(lookback)).toISOString().slice(0, 10);
}

/**
 * Windows longer than the detail log still holds must come from the rollups,
 * otherwise the chart silently loses its tail.
 *
 * The threshold *is* the configured detail retention rather than a constant
 * beside it: with the two able to drift, raising `detailRetentionDays` kept
 * extra rows that nothing would ever read.
 */
function usesRollup(lookback: Lookback): boolean {
  return LOOKBACK_DAYS[lookback] > retentionDays().detail;
}

/** Numeric columns arrive as strings from some drivers; normalise once. */
function num(value: unknown): number {
  return Number(value ?? 0);
}

/**
 * Build the WHERE clause for a window, against whichever table serves it.
 */
function scopeLogs(filters: UsageFilters): SQL {
  const conditions = [gte(t.tokenUsageLogs.timestamp, windowStartMs(filters.lookback))];

  if (filters.clientId && filters.clientId !== 'all') {
    conditions.push(eq(t.tokenUsageLogs.clientId, filters.clientId));
  }
  if (filters.provider && filters.provider !== 'all') {
    conditions.push(eq(t.tokenUsageLogs.provider, filters.provider));
  }
  if (filters.apiKeyId && filters.apiKeyId !== 'all') {
    conditions.push(
      // Detail rows store NULL for "no key"; rollups store ''.
      filters.apiKeyId === NO_API_KEY
        ? isNull(t.tokenUsageLogs.apiKeyId)
        : eq(t.tokenUsageLogs.apiKeyId, filters.apiKeyId),
    );
  }

  return and(...conditions)!;
}

function scopeRollups(filters: UsageFilters): SQL {
  const rollups = t.tokenUsageDailyRollups;
  const conditions = [gte(rollups.date, windowStartDate(filters.lookback))];

  if (filters.clientId && filters.clientId !== 'all') {
    conditions.push(eq(rollups.clientId, filters.clientId));
  }
  if (filters.provider && filters.provider !== 'all') {
    conditions.push(eq(rollups.provider, filters.provider));
  }
  if (filters.apiKeyId && filters.apiKeyId !== 'all') {
    conditions.push(
      eq(rollups.apiKeyId, filters.apiKeyId === NO_API_KEY ? '' : filters.apiKeyId),
    );
  }

  return and(...conditions)!;
}

/**
 * Time-series of spend, tokens and savings for the dashboard chart.
 */
export async function getUsageSeries(filters: UsageFilters): Promise<UsagePoint[]> {
  const rollups = t.tokenUsageDailyRollups;

  if (usesRollup(filters.lookback)) {
    const rows = await getDb()
      .select({
        period: rollups.date,
        requests: sql<number>`sum(${rollups.totalRequests})`,
        inputTokens: sql<number>`sum(${rollups.totalInputTokens})`,
        outputTokens: sql<number>`sum(${rollups.totalOutputTokens})`,
        tokensSaved: sql<number>`sum(${rollups.totalTokensSaved})`,
        totalCost: sql<number>`sum(${rollups.totalInputCost} + ${rollups.totalOutputCost})`,
        costSaved: sql<number>`sum(${rollups.totalCostSaved})`,
      })
      .from(rollups)
      .where(scopeRollups(filters))
      .groupBy(rollups.date)
      .orderBy(asc(rollups.date));

    return rows.map((row) => ({
      period: row.period,
      requests: num(row.requests),
      inputTokens: num(row.inputTokens),
      outputTokens: num(row.outputTokens),
      totalTokens: num(row.inputTokens) + num(row.outputTokens),
      tokensSaved: num(row.tokensSaved),
      totalCost: num(row.totalCost),
      costSaved: num(row.costSaved),
    }));
  }

  // '24h' is charted hourly; the shorter multi-day windows are charted daily.
  const logs = t.tokenUsageLogs;
  const bucket = timeBucket(logs.timestamp, filters.lookback === '24h' ? 'hour' : 'day');

  const rows = await getDb()
    .select({
      period: bucket,
      requests: sql<number>`count(*)`,
      inputTokens: sql<number>`sum(${logs.inputTokens})`,
      outputTokens: sql<number>`sum(${logs.outputTokens})`,
      tokensSaved: sql<number>`sum(${logs.tokensSaved})`,
      totalCost: sql<number>`sum(${logs.inputCost} + ${logs.outputCost})`,
      costSaved: sql<number>`sum(${logs.costSaved})`,
    })
    .from(logs)
    .where(scopeLogs(filters))
    .groupBy(bucket)
    .orderBy(asc(bucket));

  return rows.map((row) => ({
    period: row.period,
    requests: num(row.requests),
    inputTokens: num(row.inputTokens),
    outputTokens: num(row.outputTokens),
    totalTokens: num(row.inputTokens) + num(row.outputTokens),
    tokensSaved: num(row.tokensSaved),
    totalCost: num(row.totalCost),
    costSaved: num(row.costSaved),
  }));
}

/**
 * Per-model leaderboard for the selected window.
 */
export async function getModelStats(filters: UsageFilters): Promise<ModelStat[]> {
  const rollups = t.tokenUsageDailyRollups;
  const logs = t.tokenUsageLogs;

  const rows = usesRollup(filters.lookback)
    ? await getDb()
        .select({
          fullModelName: rollups.fullModelName,
          provider: rollups.provider,
          requests: sql<number>`sum(${rollups.totalRequests})`,
          inputTokens: sql<number>`sum(${rollups.totalInputTokens})`,
          outputTokens: sql<number>`sum(${rollups.totalOutputTokens})`,
          totalCost: sql<number>`sum(${rollups.totalInputCost} + ${rollups.totalOutputCost})`,
        })
        .from(rollups)
        .where(scopeRollups(filters))
        .groupBy(rollups.fullModelName, rollups.provider)
    : await getDb()
        .select({
          fullModelName: logs.fullModelName,
          provider: logs.provider,
          requests: sql<number>`count(*)`,
          inputTokens: sql<number>`sum(${logs.inputTokens})`,
          outputTokens: sql<number>`sum(${logs.outputTokens})`,
          totalCost: sql<number>`sum(${logs.inputCost} + ${logs.outputCost})`,
        })
        .from(logs)
        .where(scopeLogs(filters))
        .groupBy(logs.fullModelName, logs.provider);

  return rows
    .map((row) => ({
      fullModelName: row.fullModelName,
      provider: row.provider,
      requests: num(row.requests),
      inputTokens: num(row.inputTokens),
      outputTokens: num(row.outputTokens),
      totalTokens: num(row.inputTokens) + num(row.outputTokens),
      totalCost: num(row.totalCost),
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);
}

/**
 * Spend grouped by provider, for the breakdown panel.
 */
export async function getProviderStats(
  filters: UsageFilters,
): Promise<Array<GroupStat & { provider: string }>> {
  const rollups = t.tokenUsageDailyRollups;
  const logs = t.tokenUsageLogs;

  const rows = usesRollup(filters.lookback)
    ? await getDb()
        .select({
          provider: rollups.provider,
          requests: sql<number>`sum(${rollups.totalRequests})`,
          totalTokens: sql<number>`sum(${rollups.totalInputTokens} + ${rollups.totalOutputTokens})`,
          totalCost: sql<number>`sum(${rollups.totalInputCost} + ${rollups.totalOutputCost})`,
        })
        .from(rollups)
        .where(scopeRollups(filters))
        .groupBy(rollups.provider)
    : await getDb()
        .select({
          provider: logs.provider,
          requests: sql<number>`count(*)`,
          totalTokens: sql<number>`sum(${logs.inputTokens} + ${logs.outputTokens})`,
          totalCost: sql<number>`sum(${logs.inputCost} + ${logs.outputCost})`,
        })
        .from(logs)
        .where(scopeLogs(filters))
        .groupBy(logs.provider);

  return rows
    .map((row) => ({
      provider: row.provider,
      requests: num(row.requests),
      totalTokens: num(row.totalTokens),
      totalCost: num(row.totalCost),
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);
}

/**
 * Spend grouped by client, used for per-client budgeting views.
 */
export async function getClientStats(
  filters: UsageFilters,
): Promise<Array<GroupStat & { clientId: string }>> {
  const rollups = t.tokenUsageDailyRollups;
  const logs = t.tokenUsageLogs;

  const rows = usesRollup(filters.lookback)
    ? await getDb()
        .select({
          clientId: rollups.clientId,
          requests: sql<number>`sum(${rollups.totalRequests})`,
          totalTokens: sql<number>`sum(${rollups.totalInputTokens} + ${rollups.totalOutputTokens})`,
          totalCost: sql<number>`sum(${rollups.totalInputCost} + ${rollups.totalOutputCost})`,
        })
        .from(rollups)
        .where(scopeRollups(filters))
        .groupBy(rollups.clientId)
    : await getDb()
        .select({
          clientId: logs.clientId,
          requests: sql<number>`count(*)`,
          totalTokens: sql<number>`sum(${logs.inputTokens} + ${logs.outputTokens})`,
          totalCost: sql<number>`sum(${logs.inputCost} + ${logs.outputCost})`,
        })
        .from(logs)
        .where(scopeLogs(filters))
        .groupBy(logs.clientId);

  return rows
    .map((row) => ({
      clientId: row.clientId,
      requests: num(row.requests),
      totalTokens: num(row.totalTokens),
      totalCost: num(row.totalCost),
    }))
    .sort((a, b) => b.totalCost - a.totalCost);
}

/**
 * What each compression engine saved over the window.
 *
 * Only the detail log carries per-engine attribution — the daily rollups store
 * one total, because the set of engines is not fixed and widening the rollup key
 * per engine would multiply its row count. Longer windows therefore report
 * `available: false` rather than a silently partial breakdown.
 */
export async function getCompressionBreakdown(
  filters: UsageFilters,
): Promise<CompressionBreakdown> {
  if (usesRollup(filters.lookback)) {
    return { engines: [], tokensSaved: 0, available: false };
  }

  const logs = t.tokenUsageLogs;
  const rows = await getDb()
    .select({ breakdown: logs.compressionBreakdown })
    .from(logs)
    .where(and(scopeLogs(filters), isNotNull(logs.compressionBreakdown)));

  const totals = new Map<string, { requests: number; tokensSaved: number }>();

  for (const row of rows) {
    let parsed: Record<string, number>;
    try {
      parsed = JSON.parse(String(row.breakdown)) as Record<string, number>;
    } catch {
      // A malformed row is skipped, not counted as zero savings for everything.
      continue;
    }

    for (const [engine, saved] of Object.entries(parsed)) {
      const entry = totals.get(engine) ?? { requests: 0, tokensSaved: 0 };
      entry.requests += 1;
      entry.tokensSaved += num(saved);
      totals.set(engine, entry);
    }
  }

  const tokensSaved = Array.from(totals.values()).reduce(
    (sum, entry) => sum + entry.tokensSaved,
    0,
  );

  const engines = Array.from(totals.entries())
    .map(([engine, entry]) => ({
      engine,
      requests: entry.requests,
      tokensSaved: entry.tokensSaved,
      sharePercent: tokensSaved > 0 ? (entry.tokensSaved / tokensSaved) * 100 : 0,
    }))
    .sort((a, b) => b.tokensSaved - a.tokensSaved);

  return { engines, tokensSaved, available: true };
}

/**
 * Spend grouped by the gateway API key that authorised each request.
 */
export async function getApiKeyStats(filters: UsageFilters): Promise<ApiKeyStat[]> {
  const rollups = t.tokenUsageDailyRollups;
  const logs = t.tokenUsageLogs;
  const keys = t.apiKeys;

  const rows = usesRollup(filters.lookback)
    ? await getDb()
        .select({
          apiKeyId: rollups.apiKeyId,
          name: keys.name,
          revoked: keys.revoked,
          requests: sql<number>`sum(${rollups.totalRequests})`,
          totalTokens: sql<number>`sum(${rollups.totalInputTokens} + ${rollups.totalOutputTokens})`,
          totalCost: sql<number>`sum(${rollups.totalInputCost} + ${rollups.totalOutputCost})`,
        })
        .from(rollups)
        .leftJoin(keys, eq(keys.id, rollups.apiKeyId))
        .where(scopeRollups(filters))
        .groupBy(rollups.apiKeyId, keys.name, keys.revoked)
    : await getDb()
        .select({
          apiKeyId: logs.apiKeyId,
          name: keys.name,
          revoked: keys.revoked,
          requests: sql<number>`count(*)`,
          totalTokens: sql<number>`sum(${logs.inputTokens} + ${logs.outputTokens})`,
          totalCost: sql<number>`sum(${logs.inputCost} + ${logs.outputCost})`,
        })
        .from(logs)
        .leftJoin(keys, eq(keys.id, logs.apiKeyId))
        .where(scopeLogs(filters))
        .groupBy(logs.apiKeyId, keys.name, keys.revoked);

  return rows
    .map((row) => ({
      apiKeyId: row.apiKeyId || NO_API_KEY,
      name: row.name || (row.apiKeyId ? 'deleted key' : 'no key'),
      revoked: row.revoked === 1,
      requests: num(row.requests),
      totalTokens: num(row.totalTokens),
      totalCost: num(row.totalCost),
    }))
    .sort((a, b) => b.totalCost - a.totalCost || b.totalTokens - a.totalTokens);
}

/**
 * Headline numbers for the stat cards.
 */
export async function getUsageSummary(filters: UsageFilters): Promise<UsageSummary> {
  const rollups = t.tokenUsageDailyRollups;
  const logs = t.tokenUsageLogs;

  const [row] = usesRollup(filters.lookback)
    ? await getDb()
        .select({
          requests: sql<number>`coalesce(sum(${rollups.totalRequests}), 0)`,
          inputTokens: sql<number>`coalesce(sum(${rollups.totalInputTokens}), 0)`,
          outputTokens: sql<number>`coalesce(sum(${rollups.totalOutputTokens}), 0)`,
          tokensSaved: sql<number>`coalesce(sum(${rollups.totalTokensSaved}), 0)`,
          cachedInputTokens: sql<number>`coalesce(sum(${rollups.totalCachedInputTokens}), 0)`,
          totalCost: sql<number>`coalesce(sum(${rollups.totalInputCost} + ${rollups.totalOutputCost}), 0)`,
          costSaved: sql<number>`coalesce(sum(${rollups.totalCostSaved}), 0)`,
          cacheCostSaved: sql<number>`coalesce(sum(${rollups.totalCacheCostSaved}), 0)`,
          avgDurationMs: sql<number>`0`,
        })
        .from(rollups)
        .where(scopeRollups(filters))
    : await getDb()
        .select({
          requests: sql<number>`count(*)`,
          inputTokens: sql<number>`coalesce(sum(${logs.inputTokens}), 0)`,
          outputTokens: sql<number>`coalesce(sum(${logs.outputTokens}), 0)`,
          tokensSaved: sql<number>`coalesce(sum(${logs.tokensSaved}), 0)`,
          cachedInputTokens: sql<number>`coalesce(sum(${logs.cachedInputTokens}), 0)`,
          totalCost: sql<number>`coalesce(sum(${logs.inputCost} + ${logs.outputCost}), 0)`,
          costSaved: sql<number>`coalesce(sum(${logs.costSaved}), 0)`,
          cacheCostSaved: sql<number>`coalesce(sum(${logs.cacheCostSaved}), 0)`,
          avgDurationMs: sql<number>`coalesce(avg(${logs.durationMs}), 0)`,
        })
        .from(logs)
        .where(scopeLogs(filters));

  const inputTokens = num(row?.inputTokens);
  const outputTokens = num(row?.outputTokens);
  const totalCost = num(row?.totalCost);
  const costSaved = num(row?.costSaved);
  const cacheCostSaved = num(row?.cacheCostSaved);
  /**
   * What this window would have cost with neither engine running.
   *
   * The cache saving belongs in here for the same reason the compression saving does — both are money
   * that was not spent — and leaving it out was why a deployment reading 77% of its input from cache
   * reported no benefit at all.
   */
  const originalCost = totalCost + costSaved + cacheCostSaved;

  return {
    requests: num(row?.requests),
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    tokensSaved: num(row?.tokensSaved),
    cachedInputTokens: num(row?.cachedInputTokens),
    totalCost,
    costSaved,
    cacheCostSaved,
    originalCost,
    savingsPercent: originalCost > 0 ? ((costSaved + cacheCostSaved) / originalCost) * 100 : 0,
    avgDurationMs: num(row?.avgDurationMs),
    pendingWrites: tokenMetricsLogger.pendingCount(),
  };
}

/**
 * Most recent individual requests, for the live activity table.
 */
export async function getRecentLogs(limit = 50): Promise<any[]> {
  const logs = t.tokenUsageLogs;
  const keys = t.apiKeys;
  const capped = Math.min(Math.max(limit, 1), 500);

  const rows = await getDb()
    .select({
      id: logs.id,
      timestamp: logs.timestamp,
      clientId: logs.clientId,
      fullModelName: logs.fullModelName,
      provider: logs.provider,
      protocol: logs.protocol,
      streamed: logs.streamed,
      statusCode: logs.statusCode,
      durationMs: logs.durationMs,
      inputTokens: logs.inputTokens,
      outputTokens: logs.outputTokens,
      tokensSaved: logs.tokensSaved,
      estimated: logs.estimated,
      totalCost: sql<number>`${logs.inputCost} + ${logs.outputCost}`,
      apiKeyId: logs.apiKeyId,
      apiKeyName: keys.name,
    })
    .from(logs)
    .leftJoin(keys, eq(keys.id, logs.apiKeyId))
    .orderBy(desc(logs.timestamp))
    .limit(capped);

  return rows.map((row) => ({
    ...row,
    timestamp: num(row.timestamp),
    totalCost: num(row.totalCost),
  }));
}

/**
 * Distinct client IDs seen in the retention window, for the filter dropdown.
 */
export async function getKnownClients(): Promise<string[]> {
  const rows = await getDb()
    .selectDistinct({ clientId: t.tokenUsageLogs.clientId })
    .from(t.tokenUsageLogs)
    .orderBy(asc(t.tokenUsageLogs.clientId));
  return rows.map((row) => row.clientId);
}

const CSV_COLUMNS = [
  'timestamp',
  'client_id',
  'api_key_id',
  'provider',
  'model',
  'full_model_name',
  'protocol',
  'streamed',
  'status_code',
  'duration_ms',
  'input_tokens',
  'output_tokens',
  'cached_input_tokens',
  'tokens_saved',
  'compression_breakdown',
  'estimated',
  'input_cost',
  'output_cost',
  'cost_saved',
] as const;

/**
 * Flatten the detail log into CSV for the export button.
 */
export async function exportLogsCsv(filters: UsageFilters): Promise<string> {
  const logs = t.tokenUsageLogs;

  // Export always reads the detail table: the rollup has no per-request rows.
  const rows = await getDb()
    .select({
      timestamp: logs.timestamp,
      client_id: logs.clientId,
      api_key_id: logs.apiKeyId,
      provider: logs.provider,
      model: logs.model,
      full_model_name: logs.fullModelName,
      protocol: logs.protocol,
      streamed: logs.streamed,
      status_code: logs.statusCode,
      duration_ms: logs.durationMs,
      input_tokens: logs.inputTokens,
      output_tokens: logs.outputTokens,
      cached_input_tokens: logs.cachedInputTokens,
      tokens_saved: logs.tokensSaved,
      compression_breakdown: logs.compressionBreakdown,
      estimated: logs.estimated,
      input_cost: logs.inputCost,
      output_cost: logs.outputCost,
      cost_saved: logs.costSaved,
    })
    .from(logs)
    .where(scopeLogs(filters))
    .orderBy(asc(logs.timestamp));

  const lines = [CSV_COLUMNS.join(',')];
  for (const row of rows as Record<string, unknown>[]) {
    lines.push(
      CSV_COLUMNS.map((column) => {
        const value =
          column === 'timestamp' ? new Date(num(row.timestamp)).toISOString() : row[column];
        const text = value === null || value === undefined ? '' : String(value);
        return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
      }).join(','),
    );
  }

  return lines.join('\n');
}
