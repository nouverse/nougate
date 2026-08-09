import { sql } from 'drizzle-orm';
import {
  bigint,
  doublePrecision,
  index,
  integer,
  pgTable,
  primaryKey,
  serial,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Postgres schema. Structurally identical to `./sqlite.ts`.
 *
 * Deliberate type choices, so the same values round-trip identically:
 *  - epoch milliseconds are `bigint({ mode: 'number' })`, not `timestamp` — the
 *    application works in numbers everywhere and converting only here would
 *    make the two dialects disagree.
 *  - costs are `doublePrecision`, matching SQLite's REAL.
 *  - booleans stay 0/1 integers rather than `boolean`, so no call site needs to
 *    know which database it is talking to.
 *
 * If you change one schema, change the other.
 */

const epochMs = (name: string) => bigint(name, { mode: 'number' });

export const tokenUsageLogs = pgTable(
  'token_usage_logs',
  {
    id: serial('id').primaryKey(),
    timestamp: epochMs('timestamp').notNull(),
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
    inputCost: doublePrecision('input_cost').notNull().default(0),
    outputCost: doublePrecision('output_cost').notNull().default(0),
    costSaved: doublePrecision('cost_saved').notNull().default(0),
  },
  (table) => [
    index('idx_token_logs_timestamp').on(table.timestamp),
    index('idx_token_logs_model').on(table.fullModelName),
    index('idx_token_logs_client').on(table.clientId),
    index('idx_token_logs_provider').on(table.provider),
    index('idx_token_logs_api_key').on(table.apiKeyId),
  ],
);

export const tokenUsageDailyRollups = pgTable(
  'token_usage_daily_rollups',
  {
    date: text('date').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    fullModelName: text('full_model_name').notNull(),
    clientId: text('client_id').notNull(),
    apiKeyId: text('api_key_id').notNull().default(''),
    totalRequests: integer('total_requests').notNull().default(0),
    totalInputTokens: bigint('total_input_tokens', { mode: 'number' }).notNull().default(0),
    totalOutputTokens: bigint('total_output_tokens', { mode: 'number' }).notNull().default(0),
    totalTokensSaved: bigint('total_tokens_saved', { mode: 'number' }).notNull().default(0),
    totalInputCost: doublePrecision('total_input_cost').notNull().default(0),
    totalOutputCost: doublePrecision('total_output_cost').notNull().default(0),
    totalCostSaved: doublePrecision('total_cost_saved').notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.date, table.fullModelName, table.clientId, table.apiKeyId] }),
    index('idx_rollups_date').on(table.date),
    index('idx_rollups_api_key').on(table.apiKeyId),
  ],
);

export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    username: text('username').notNull(),
    passwordHash: text('password_hash').notNull(),
    mustChangePassword: integer('must_change_password').notNull().default(0),
    createdAt: epochMs('created_at').notNull(),
    lastLoginAt: epochMs('last_login_at'),
  },
  (table) => [
    // Postgres has no COLLATE NOCASE, so uniqueness is enforced on the folded
    // value. Usernames are normalised to lowercase before insert anyway; this
    // is the backstop.
    uniqueIndex('idx_users_username_lower').on(sql`lower(${table.username})`),
  ],
);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    keyHash: text('key_hash').notNull().unique(),
    keyPrefix: text('key_prefix').notNull(),
    createdAt: epochMs('created_at').notNull(),
    lastUsedAt: epochMs('last_used_at'),
    expiresAt: epochMs('expires_at'),
    revoked: integer('revoked').notNull().default(0),
    requestCount: integer('request_count').notNull().default(0),
    allowedProviders: text('allowed_providers'),
  },
  (table) => [index('idx_api_keys_hash').on(table.keyHash)],
);

export const customProviders = pgTable('custom_providers', {
  id: text('id').primaryKey(),
  displayName: text('display_name').notNull(),
  baseUrl: text('base_url').notNull(),
  apiStyle: text('api_style').notNull().default('openai'),
  enabled: integer('enabled').notNull().default(1),
  extraHeaders: text('extra_headers'),
  // Nullable rather than defaulted: null means "never configured", which reads
  // back as the shared DEFAULT_JITTER_CONFIG instead of a stored 0.
  jitterEnabled: integer('jitter_enabled'),
  jitterMinMs: integer('jitter_min_ms'),
  jitterMaxMs: integer('jitter_max_ms'),
  createdAt: epochMs('created_at').notNull(),
  updatedAt: epochMs('updated_at').notNull(),
});

export const customProviderKeys = pgTable(
  'custom_provider_keys',
  {
    id: text('id').primaryKey(),
    providerId: text('provider_id')
      .notNull()
      .references(() => customProviders.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    apiKey: text('api_key').notNull(),
    healthScore: integer('health_score').notNull().default(100),
    lastUsed: epochMs('last_used').notNull().default(0),
    cooldownUntil: epochMs('cooldown_until').notNull().default(0),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    tokenUsage: bigint('token_usage', { mode: 'number' }).notNull().default(0),
    createdAt: epochMs('created_at').notNull(),
  },
  (table) => [index('idx_custom_keys_provider').on(table.providerId)],
);

export const customProviderModels = pgTable(
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
    inputPricePer1M: doublePrecision('input_price_per_1m'),
    outputPricePer1M: doublePrecision('output_price_per_1m'),
    enabled: integer('enabled').notNull().default(1),
  },
  (table) => [primaryKey({ columns: [table.providerId, table.modelId] })],
);

/**
 * Postgres equivalent of the SQLite `strftime` bucketing, producing byte-for-byte
 * the same label so the dashboard cannot tell the two apart.
 */
export function timeBucket(column: unknown, granularity: 'hour' | 'day') {
  // Inlined rather than bound: Postgres cannot infer a type for a parameter in
  // to_char's format position. The value is a constant from this file, never
  // user input.
  const format = sql.raw(
    granularity === 'hour' ? `'YYYY-MM-DD"T"HH24:00'` : `'YYYY-MM-DD'`,
  );
  return sql<string>`to_char(to_timestamp(${column} / 1000.0) at time zone 'UTC', ${format})`;
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
