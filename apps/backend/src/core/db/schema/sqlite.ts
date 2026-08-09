import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * SQLite schema. Kept structurally identical to `./pg.ts` — the two are the
 * same tables expressed in each dialect's builder, because Drizzle schemas are
 * dialect-typed and cannot be shared.
 *
 * If you change one, change the other.
 */

export const tokenUsageLogs = sqliteTable(
  'token_usage_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    timestamp: integer('timestamp').notNull(),
    sessionId: text('session_id'),
    clientId: text('client_id').notNull().default('unknown'),
    apiKeyId: text('api_key_id'),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    fullModelName: text('full_model_name').notNull(),
    protocol: text('protocol').notNull().default('openai'),
    streamed: integer('streamed').notNull().default(0),
    statusCode: integer('status_code').notNull().default(200),
    durationMs: integer('duration_ms').notNull().default(0),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cachedInputTokens: integer('cached_input_tokens').notNull().default(0),
    tokensBeforeCompression: integer('tokens_before_compression'),
    tokensAfterCompression: integer('tokens_after_compression'),
    tokensSaved: integer('tokens_saved').notNull().default(0),
    /** JSON: which engine saved what, e.g. {"rtk":180,"headroom":40}. */
    compressionBreakdown: text('compression_breakdown'),
    estimated: integer('estimated').notNull().default(0),
    inputCost: real('input_cost').notNull().default(0),
    outputCost: real('output_cost').notNull().default(0),
    costSaved: real('cost_saved').notNull().default(0),
  },
  (table) => [
    index('idx_token_logs_timestamp').on(table.timestamp),
    index('idx_token_logs_model').on(table.fullModelName),
    index('idx_token_logs_client').on(table.clientId),
    index('idx_token_logs_provider').on(table.provider),
    index('idx_token_logs_api_key').on(table.apiKeyId),
  ],
);

export const tokenUsageDailyRollups = sqliteTable(
  'token_usage_daily_rollups',
  {
    date: text('date').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    fullModelName: text('full_model_name').notNull(),
    clientId: text('client_id').notNull(),
    apiKeyId: text('api_key_id').notNull().default(''),
    totalRequests: integer('total_requests').notNull().default(0),
    totalInputTokens: integer('total_input_tokens').notNull().default(0),
    totalOutputTokens: integer('total_output_tokens').notNull().default(0),
    totalTokensSaved: integer('total_tokens_saved').notNull().default(0),
    totalInputCost: real('total_input_cost').notNull().default(0),
    totalOutputCost: real('total_output_cost').notNull().default(0),
    totalCostSaved: real('total_cost_saved').notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.date, table.fullModelName, table.clientId, table.apiKeyId] }),
    index('idx_rollups_date').on(table.date),
    index('idx_rollups_api_key').on(table.apiKeyId),
  ],
);

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  // NOCASE makes the unique constraint case-insensitive, so "Admin" cannot be
  // registered alongside "admin". Postgres gets the same effect from a
  // lower(username) unique index.
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  mustChangePassword: integer('must_change_password').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  lastLoginAt: integer('last_login_at'),
});

export const apiKeys = sqliteTable(
  'api_keys',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    keyHash: text('key_hash').notNull().unique(),
    keyPrefix: text('key_prefix').notNull(),
    createdAt: integer('created_at').notNull(),
    lastUsedAt: integer('last_used_at'),
    expiresAt: integer('expires_at'),
    revoked: integer('revoked').notNull().default(0),
    requestCount: integer('request_count').notNull().default(0),
    allowedProviders: text('allowed_providers'),
  },
  (table) => [index('idx_api_keys_hash').on(table.keyHash)],
);

export const customProviders = sqliteTable('custom_providers', {
  id: text('id').primaryKey(),
  displayName: text('display_name').notNull(),
  baseUrl: text('base_url').notNull(),
  apiStyle: text('api_style').notNull().default('openai'),
  enabled: integer('enabled').notNull().default(1),
  extraHeaders: text('extra_headers'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const customProviderKeys = sqliteTable(
  'custom_provider_keys',
  {
    id: text('id').primaryKey(),
    providerId: text('provider_id')
      .notNull()
      .references(() => customProviders.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    apiKey: text('api_key').notNull(),
    healthScore: integer('health_score').notNull().default(100),
    lastUsed: integer('last_used').notNull().default(0),
    cooldownUntil: integer('cooldown_until').notNull().default(0),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    tokenUsage: integer('token_usage').notNull().default(0),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [index('idx_custom_keys_provider').on(table.providerId)],
);

export const customProviderModels = sqliteTable(
  'custom_provider_models',
  {
    providerId: text('provider_id')
      .notNull()
      .references(() => customProviders.id, { onDelete: 'cascade' }),
    modelId: text('model_id').notNull(),
    displayName: text('display_name'),
    upstreamModelId: text('upstream_model_id'),
    pool: text('pool').notNull().default('cli'),
    isThinking: integer('is_thinking').notNull().default(0),
    thinkingMode: text('thinking_mode'),
    thinkingBudget: integer('thinking_budget'),
    maxOutputTokens: integer('max_output_tokens').notNull().default(8192),
    timeoutMs: integer('timeout_ms').notNull().default(60000),
    inputPricePer1M: real('input_price_per_1m'),
    outputPricePer1M: real('output_price_per_1m'),
    enabled: integer('enabled').notNull().default(1),
  },
  (table) => [primaryKey({ columns: [table.providerId, table.modelId] })],
);

/**
 * Bucket a millisecond timestamp column into an hour or a day label.
 *
 * This is the one piece of query logic the two dialects genuinely disagree on,
 * so it lives beside the schema rather than being branched at every call site.
 */
export function timeBucket(column: unknown, granularity: 'hour' | 'day') {
  // Inlined to match the Postgres side, which has to inline it.
  const format = sql.raw(granularity === 'hour' ? `'%Y-%m-%dT%H:00'` : `'%Y-%m-%d'`);
  return sql<string>`strftime(${format}, ${column} / 1000, 'unixepoch')`;
}

export const schema = {
  tokenUsageLogs,
  tokenUsageDailyRollups,
  users,
  apiKeys,
  customProviders,
  customProviderKeys,
  customProviderModels,
};
