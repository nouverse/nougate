/**
 * Postgres DDL, mirroring `../schema/pg.ts` — the same tables and indexes as
 * `./sqlite.ts`, in Postgres types.
 *
 * Type choices are deliberate so values round-trip identically on both
 * backends: epoch milliseconds are BIGINT (not TIMESTAMP), costs are DOUBLE
 * PRECISION (matching SQLite REAL), and booleans stay 0/1 INTEGER so no call
 * site needs to know which database it is talking to.
 *
 * Every statement is `IF NOT EXISTS`, so running them on every boot is
 * idempotent.
 */
export const ddl = [
  // ─── Token usage & cost ─────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS token_usage_logs (
    id SERIAL PRIMARY KEY,
    timestamp BIGINT NOT NULL,
    session_id TEXT,
    client_id TEXT NOT NULL DEFAULT 'unknown',
    api_key_id TEXT,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    full_model_name TEXT NOT NULL,
    protocol TEXT NOT NULL DEFAULT 'openai',
    streamed INTEGER NOT NULL DEFAULT 0,
    status_code INTEGER NOT NULL DEFAULT 200,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cached_input_tokens INTEGER NOT NULL DEFAULT 0,
    tokens_before_compression INTEGER,
    tokens_after_compression INTEGER,
    tokens_saved INTEGER NOT NULL DEFAULT 0,
    estimated INTEGER NOT NULL DEFAULT 0,
    input_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
    output_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
    cost_saved DOUBLE PRECISION NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_token_logs_timestamp ON token_usage_logs (timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_token_logs_model ON token_usage_logs (full_model_name)`,
  `CREATE INDEX IF NOT EXISTS idx_token_logs_client ON token_usage_logs (client_id)`,
  `CREATE INDEX IF NOT EXISTS idx_token_logs_provider ON token_usage_logs (provider)`,
  `CREATE INDEX IF NOT EXISTS idx_token_logs_api_key ON token_usage_logs (api_key_id)`,

  `CREATE TABLE IF NOT EXISTS token_usage_daily_rollups (
    date TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    full_model_name TEXT NOT NULL,
    client_id TEXT NOT NULL,
    api_key_id TEXT NOT NULL DEFAULT '',
    total_requests INTEGER NOT NULL DEFAULT 0,
    total_input_tokens BIGINT NOT NULL DEFAULT 0,
    total_output_tokens BIGINT NOT NULL DEFAULT 0,
    total_tokens_saved BIGINT NOT NULL DEFAULT 0,
    total_input_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
    total_output_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
    total_cost_saved DOUBLE PRECISION NOT NULL DEFAULT 0,
    PRIMARY KEY (date, full_model_name, client_id, api_key_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_rollups_date ON token_usage_daily_rollups (date)`,
  `CREATE INDEX IF NOT EXISTS idx_rollups_api_key ON token_usage_daily_rollups (api_key_id)`,

  // ─── Dashboard users ────────────────────────────────────────────────────────
  // Postgres has no COLLATE NOCASE, so case-insensitive uniqueness comes from a
  // unique index on the folded value instead.
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL,
    last_login_at BIGINT
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower ON users (lower(username))`,

  // ─── Gateway API keys ───────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    key_prefix TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    last_used_at BIGINT,
    expires_at BIGINT,
    revoked INTEGER NOT NULL DEFAULT 0,
    request_count INTEGER NOT NULL DEFAULT 0,
    allowed_providers TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys (key_hash)`,

  // ─── Custom providers ───────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS custom_providers (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    api_style TEXT NOT NULL DEFAULT 'openai',
    enabled INTEGER NOT NULL DEFAULT 1,
    extra_headers TEXT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS custom_provider_keys (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL REFERENCES custom_providers (id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    api_key TEXT NOT NULL,
    health_score INTEGER NOT NULL DEFAULT 100,
    last_used BIGINT NOT NULL DEFAULT 0,
    cooldown_until BIGINT NOT NULL DEFAULT 0,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    token_usage BIGINT NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_custom_keys_provider ON custom_provider_keys (provider_id)`,

  `CREATE TABLE IF NOT EXISTS custom_provider_models (
    provider_id TEXT NOT NULL REFERENCES custom_providers (id) ON DELETE CASCADE,
    model_id TEXT NOT NULL,
    display_name TEXT,
    upstream_model_id TEXT,
    pool TEXT NOT NULL DEFAULT 'cli',
    is_thinking INTEGER NOT NULL DEFAULT 0,
    thinking_mode TEXT,
    thinking_budget INTEGER,
    max_output_tokens INTEGER NOT NULL DEFAULT 8192,
    timeout_ms INTEGER NOT NULL DEFAULT 60000,
    input_price_per_1m DOUBLE PRECISION,
    output_price_per_1m DOUBLE PRECISION,
    enabled INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (provider_id, model_id)
  )`,
];
