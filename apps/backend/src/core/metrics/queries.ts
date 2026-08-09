import { type SqlParams, dbAll, dbGet } from '@/core/db';
import { tokenMetricsLogger } from '@/core/metrics/logger';

export type Lookback = '24h' | '7d' | '14d' | '30d' | '60d' | '90d';

const LOOKBACK_DAYS: Record<Lookback, number> = {
  '24h': 1,
  '7d': 7,
  '14d': 14,
  '30d': 30,
  '60d': 60,
  '90d': 90,
};

/**
 * Windows longer than the detail-log retention must be served from rollups,
 * otherwise the chart silently loses its tail.
 */
const ROLLUP_THRESHOLD_DAYS = 14;

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

/** Filter value for requests made while gateway key auth was off. */
export const NO_API_KEY = 'none';

export interface ApiKeyStat {
  apiKeyId: string;
  /** The key's name, or a placeholder when it was deleted or never used. */
  name: string;
  revoked: boolean;
  requests: number;
  totalTokens: number;
  totalCost: number;
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
  totalCost: number;
  costSaved: number;
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

function usesRollup(lookback: Lookback): boolean {
  return LOOKBACK_DAYS[lookback] > ROLLUP_THRESHOLD_DAYS;
}

interface Scope {
  clause: string;
  params: SqlParams;
  /** True when the rollup table backs this window. */
  rollup: boolean;
}

/**
 * Resolve which table serves a window and build its WHERE clause + bindings.
 */
function buildScope(filters: UsageFilters): Scope {
  const rollup = usesRollup(filters.lookback);
  const timeColumn = rollup ? 'date' : 'timestamp';
  const since = rollup ? windowStartDate(filters.lookback) : windowStartMs(filters.lookback);

  const conditions = [`${timeColumn} >= $since`];
  const params: SqlParams = { $since: since };

  if (filters.clientId && filters.clientId !== 'all') {
    conditions.push('client_id = $clientId');
    params.$clientId = filters.clientId;
  }

  if (filters.provider && filters.provider !== 'all') {
    conditions.push('provider = $provider');
    params.$provider = filters.provider;
  }

  if (filters.apiKeyId && filters.apiKeyId !== 'all') {
    if (filters.apiKeyId === NO_API_KEY) {
      // Detail rows store NULL for "no key"; rollups store ''.
      conditions.push(rollup ? "api_key_id = ''" : 'api_key_id IS NULL');
    } else {
      conditions.push('api_key_id = $apiKeyId');
      params.$apiKeyId = filters.apiKeyId;
    }
  }

  return { clause: conditions.join(' AND '), params, rollup };
}

/**
 * Time-series of spend, tokens and savings for the dashboard chart.
 */
export function getUsageSeries(filters: UsageFilters): UsagePoint[] {
  const { clause, params, rollup } = buildScope(filters);

  if (rollup) {
    return dbAll<UsagePoint>(
      `SELECT date AS period,
              SUM(total_requests) AS requests,
              SUM(total_input_tokens) AS inputTokens,
              SUM(total_output_tokens) AS outputTokens,
              SUM(total_input_tokens + total_output_tokens) AS totalTokens,
              SUM(total_tokens_saved) AS tokensSaved,
              SUM(total_input_cost + total_output_cost) AS totalCost,
              SUM(total_cost_saved) AS costSaved
       FROM token_usage_daily_rollups
       WHERE ${clause}
       GROUP BY period
       ORDER BY period ASC`,
      params,
    );
  }

  // '24h' is charted hourly; the shorter multi-day windows are charted daily.
  const bucket = filters.lookback === '24h' ? '%Y-%m-%dT%H:00' : '%Y-%m-%d';

  return dbAll<UsagePoint>(
    `SELECT strftime('${bucket}', timestamp / 1000, 'unixepoch') AS period,
            COUNT(*) AS requests,
            SUM(input_tokens) AS inputTokens,
            SUM(output_tokens) AS outputTokens,
            SUM(input_tokens + output_tokens) AS totalTokens,
            SUM(tokens_saved) AS tokensSaved,
            SUM(input_cost + output_cost) AS totalCost,
            SUM(cost_saved) AS costSaved
     FROM token_usage_logs
     WHERE ${clause}
     GROUP BY period
     ORDER BY period ASC`,
    params,
  );
}

/**
 * Per-model leaderboard for the selected window.
 */
export function getModelStats(filters: UsageFilters): ModelStat[] {
  const { clause, params, rollup } = buildScope(filters);

  if (rollup) {
    return dbAll<ModelStat>(
      `SELECT full_model_name AS fullModelName,
              provider,
              SUM(total_requests) AS requests,
              SUM(total_input_tokens) AS inputTokens,
              SUM(total_output_tokens) AS outputTokens,
              SUM(total_input_tokens + total_output_tokens) AS totalTokens,
              SUM(total_input_cost + total_output_cost) AS totalCost
       FROM token_usage_daily_rollups
       WHERE ${clause}
       GROUP BY full_model_name, provider
       ORDER BY totalTokens DESC`,
      params,
    );
  }

  return dbAll<ModelStat>(
    `SELECT full_model_name AS fullModelName,
            provider,
            COUNT(*) AS requests,
            SUM(input_tokens) AS inputTokens,
            SUM(output_tokens) AS outputTokens,
            SUM(input_tokens + output_tokens) AS totalTokens,
            SUM(input_cost + output_cost) AS totalCost
     FROM token_usage_logs
     WHERE ${clause}
     GROUP BY full_model_name, provider
     ORDER BY totalTokens DESC`,
    params,
  );
}

/**
 * Spend grouped by provider, for the breakdown panel.
 */
export function getProviderStats(filters: UsageFilters): Array<GroupStat & { provider: string }> {
  const { clause, params, rollup } = buildScope(filters);

  if (rollup) {
    return dbAll(
      `SELECT provider,
              SUM(total_requests) AS requests,
              SUM(total_input_tokens + total_output_tokens) AS totalTokens,
              SUM(total_input_cost + total_output_cost) AS totalCost
       FROM token_usage_daily_rollups
       WHERE ${clause}
       GROUP BY provider
       ORDER BY totalTokens DESC`,
      params,
    );
  }

  return dbAll(
    `SELECT provider,
            COUNT(*) AS requests,
            SUM(input_tokens + output_tokens) AS totalTokens,
            SUM(input_cost + output_cost) AS totalCost
     FROM token_usage_logs
     WHERE ${clause}
     GROUP BY provider
     ORDER BY totalTokens DESC`,
    params,
  );
}

/**
 * Spend grouped by client, used for per-client budgeting views.
 */
export function getClientStats(filters: UsageFilters): Array<GroupStat & { clientId: string }> {
  const { clause, params, rollup } = buildScope(filters);

  if (rollup) {
    return dbAll(
      `SELECT client_id AS clientId,
              SUM(total_requests) AS requests,
              SUM(total_input_tokens + total_output_tokens) AS totalTokens,
              SUM(total_input_cost + total_output_cost) AS totalCost
       FROM token_usage_daily_rollups
       WHERE ${clause}
       GROUP BY client_id
       ORDER BY totalCost DESC`,
      params,
    );
  }

  return dbAll(
    `SELECT client_id AS clientId,
            COUNT(*) AS requests,
            SUM(input_tokens + output_tokens) AS totalTokens,
            SUM(input_cost + output_cost) AS totalCost
     FROM token_usage_logs
     WHERE ${clause}
     GROUP BY client_id
     ORDER BY totalCost DESC`,
    params,
  );
}

/**
 * Spend grouped by the gateway API key that authorised each request.
 */
export function getApiKeyStats(filters: UsageFilters): ApiKeyStat[] {
  const { clause, params, rollup } = buildScope(filters);
  const table = rollup ? 'token_usage_daily_rollups' : 'token_usage_logs';
  const requests = rollup ? 'SUM(total_requests)' : 'COUNT(*)';
  const tokens = rollup
    ? 'SUM(total_input_tokens + total_output_tokens)'
    : 'SUM(input_tokens + output_tokens)';
  const cost = rollup
    ? 'SUM(total_input_cost + total_output_cost)'
    : 'SUM(input_cost + output_cost)';

  const rows = dbAll<any>(
    `SELECT COALESCE(usage.api_key_id, '') AS apiKeyId,
            k.name AS name,
            COALESCE(k.revoked, 0) AS revoked,
            ${requests} AS requests,
            ${tokens} AS totalTokens,
            ${cost} AS totalCost
     FROM ${table} AS usage
     LEFT JOIN api_keys AS k ON k.id = usage.api_key_id
     WHERE ${clause.replace(/\b(timestamp|date|client_id|provider|api_key_id)\b/g, 'usage.$1')}
     GROUP BY apiKeyId
     ORDER BY totalCost DESC, totalTokens DESC`,
    params,
  );

  return rows.map((row) => ({
    apiKeyId: row.apiKeyId || NO_API_KEY,
    name: row.name || (row.apiKeyId ? 'deleted key' : 'no key'),
    revoked: row.revoked === 1,
    requests: row.requests ?? 0,
    totalTokens: row.totalTokens ?? 0,
    totalCost: row.totalCost ?? 0,
  }));
}

/**
 * Headline numbers for the stat cards.
 */
export function getUsageSummary(filters: UsageFilters): UsageSummary {
  const { clause, params, rollup } = buildScope(filters);

  const row = rollup
    ? dbGet<any>(
        `SELECT COALESCE(SUM(total_requests), 0) AS requests,
                COALESCE(SUM(total_input_tokens), 0) AS inputTokens,
                COALESCE(SUM(total_output_tokens), 0) AS outputTokens,
                COALESCE(SUM(total_tokens_saved), 0) AS tokensSaved,
                COALESCE(SUM(total_input_cost + total_output_cost), 0) AS totalCost,
                COALESCE(SUM(total_cost_saved), 0) AS costSaved,
                0 AS avgDurationMs
         FROM token_usage_daily_rollups
         WHERE ${clause}`,
        params,
      )
    : dbGet<any>(
        `SELECT COUNT(*) AS requests,
                COALESCE(SUM(input_tokens), 0) AS inputTokens,
                COALESCE(SUM(output_tokens), 0) AS outputTokens,
                COALESCE(SUM(tokens_saved), 0) AS tokensSaved,
                COALESCE(SUM(input_cost + output_cost), 0) AS totalCost,
                COALESCE(SUM(cost_saved), 0) AS costSaved,
                COALESCE(AVG(duration_ms), 0) AS avgDurationMs
         FROM token_usage_logs
         WHERE ${clause}`,
        params,
      );

  const inputTokens = row?.inputTokens ?? 0;
  const outputTokens = row?.outputTokens ?? 0;
  const totalCost = row?.totalCost ?? 0;
  const costSaved = row?.costSaved ?? 0;
  const originalCost = totalCost + costSaved;

  return {
    requests: row?.requests ?? 0,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    tokensSaved: row?.tokensSaved ?? 0,
    totalCost,
    costSaved,
    originalCost,
    savingsPercent: originalCost > 0 ? (costSaved / originalCost) * 100 : 0,
    avgDurationMs: row?.avgDurationMs ?? 0,
    pendingWrites: tokenMetricsLogger.pendingCount(),
  };
}

/**
 * Most recent individual requests, for the live activity table.
 */
export function getRecentLogs(limit = 50): any[] {
  const capped = Math.min(Math.max(limit, 1), 500);

  return dbAll(
    `SELECT l.id, l.timestamp, l.client_id AS clientId, l.full_model_name AS fullModelName,
            l.provider, l.protocol, l.streamed, l.status_code AS statusCode,
            l.duration_ms AS durationMs, l.input_tokens AS inputTokens,
            l.output_tokens AS outputTokens, l.tokens_saved AS tokensSaved,
            l.estimated, (l.input_cost + l.output_cost) AS totalCost,
            l.api_key_id AS apiKeyId, k.name AS apiKeyName
     FROM token_usage_logs AS l
     LEFT JOIN api_keys AS k ON k.id = l.api_key_id
     ORDER BY l.timestamp DESC
     LIMIT $limit`,
    { $limit: capped },
  );
}

/**
 * Distinct client IDs seen in the retention window, for the filter dropdown.
 */
export function getKnownClients(): string[] {
  const rows = dbAll<{ clientId: string }>(
    'SELECT DISTINCT client_id AS clientId FROM token_usage_logs ORDER BY client_id ASC',
  );
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
  'estimated',
  'input_cost',
  'output_cost',
  'cost_saved',
];

/**
 * Flatten the detail log into CSV for the export button.
 */
export function exportLogsCsv(filters: UsageFilters): string {
  // Export always reads the detail table: the rollup has no per-request rows.
  const conditions = ['timestamp >= $since'];
  const params: SqlParams = { $since: windowStartMs(filters.lookback) };

  if (filters.clientId && filters.clientId !== 'all') {
    conditions.push('client_id = $clientId');
    params.$clientId = filters.clientId;
  }
  if (filters.provider && filters.provider !== 'all') {
    conditions.push('provider = $provider');
    params.$provider = filters.provider;
  }
  if (filters.apiKeyId && filters.apiKeyId !== 'all') {
    if (filters.apiKeyId === NO_API_KEY) {
      conditions.push('api_key_id IS NULL');
    } else {
      conditions.push('api_key_id = $apiKeyId');
      params.$apiKeyId = filters.apiKeyId;
    }
  }

  const rows = dbAll<Record<string, unknown>>(
    `SELECT ${CSV_COLUMNS.join(', ')}
     FROM token_usage_logs
     WHERE ${conditions.join(' AND ')}
     ORDER BY timestamp ASC`,
    params,
  );

  const lines = [CSV_COLUMNS.join(',')];
  for (const row of rows) {
    lines.push(
      CSV_COLUMNS.map((column) => {
        const value =
          column === 'timestamp' ? new Date(Number(row.timestamp)).toISOString() : row[column];
        const text = value === null || value === undefined ? '' : String(value);
        return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
      }).join(','),
    );
  }

  return lines.join('\n');
}
