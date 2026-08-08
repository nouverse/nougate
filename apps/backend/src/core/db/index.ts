import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';

/**
 * Resolve the on-disk location of the SQLite database.
 *
 * Mirrors the config manager's convention: inside Docker the persistent volume
 * is mounted at /app/data, otherwise state lives in ./data next to the repo.
 */
function resolveDbPath(): string {
  if (process.env.NOUGATE_DB_PATH) {
    return process.env.NOUGATE_DB_PATH;
  }

  return existsSync('/app/data')
    ? '/app/data/nougate.db'
    : join(process.cwd(), 'data', 'nougate.db');
}

let database: Database | null = null;
let resolvedPath: string | null = null;

/**
 * Statements that bring an empty (or older) database up to the current schema.
 * Every statement is idempotent so it can run on every boot.
 */
const SCHEMA_STATEMENTS = [
  // ─── Token usage & cost ─────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS token_usage_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
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
    input_cost REAL NOT NULL DEFAULT 0,
    output_cost REAL NOT NULL DEFAULT 0,
    cost_saved REAL NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_token_logs_timestamp ON token_usage_logs (timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_token_logs_model ON token_usage_logs (full_model_name)`,
  `CREATE INDEX IF NOT EXISTS idx_token_logs_client ON token_usage_logs (client_id)`,
  `CREATE INDEX IF NOT EXISTS idx_token_logs_provider ON token_usage_logs (provider)`,

  `CREATE TABLE IF NOT EXISTS token_usage_daily_rollups (
    date TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    full_model_name TEXT NOT NULL,
    client_id TEXT NOT NULL,
    total_requests INTEGER NOT NULL DEFAULT 0,
    total_input_tokens INTEGER NOT NULL DEFAULT 0,
    total_output_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens_saved INTEGER NOT NULL DEFAULT 0,
    total_input_cost REAL NOT NULL DEFAULT 0,
    total_output_cost REAL NOT NULL DEFAULT 0,
    total_cost_saved REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (date, full_model_name, client_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_rollups_date ON token_usage_daily_rollups (date)`,

  // ─── Gateway API keys ───────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    key_prefix TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    expires_at INTEGER,
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
    default_input_price REAL,
    default_output_price REAL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS custom_provider_keys (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL,
    label TEXT NOT NULL,
    api_key TEXT NOT NULL,
    health_score INTEGER NOT NULL DEFAULT 100,
    last_used INTEGER NOT NULL DEFAULT 0,
    cooldown_until INTEGER NOT NULL DEFAULT 0,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    token_usage INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (provider_id) REFERENCES custom_providers (id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_custom_keys_provider ON custom_provider_keys (provider_id)`,

  `CREATE TABLE IF NOT EXISTS custom_provider_models (
    provider_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    display_name TEXT,
    upstream_model_id TEXT,
    pool TEXT NOT NULL DEFAULT 'cli',
    is_thinking INTEGER NOT NULL DEFAULT 0,
    thinking_mode TEXT,
    thinking_budget INTEGER,
    max_output_tokens INTEGER NOT NULL DEFAULT 8192,
    timeout_ms INTEGER NOT NULL DEFAULT 60000,
    input_price_per_1m REAL,
    output_price_per_1m REAL,
    enabled INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (provider_id, model_id),
    FOREIGN KEY (provider_id) REFERENCES custom_providers (id) ON DELETE CASCADE
  )`,
];

/**
 * Open (once) and return the shared SQLite handle, applying the schema on first use.
 */
export function getDb(): Database {
  if (database) {
    return database;
  }

  // Resolved on first use rather than at import time: importing this module is
  // a side effect of loading a protocol handler, which happens long before any
  // caller (or test) has had a chance to point NOUGATE_DB_PATH somewhere else.
  resolvedPath = resolveDbPath();

  const dir = dirname(resolvedPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const db = new Database(resolvedPath, { create: true });

  // WAL keeps the metrics writer from blocking dashboard reads, and NORMAL
  // sync is the right trade-off for telemetry we can afford to lose a second of.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  for (const statement of SCHEMA_STATEMENTS) {
    db.exec(statement);
  }

  database = db;
  console.log(`[DB] SQLite ready at ${resolvedPath}`);
  return database;
}

/**
 * Path of the open database, or null before first use.
 */
export function getDbPath(): string | null {
  return resolvedPath;
}

/**
 * Initialize the database eagerly during server startup.
 */
export function initDb(): void {
  getDb();
}

/**
 * Named bind parameters, e.g. `{ $id: 'abc' }`.
 */
export type SqlParams = Record<string, string | number | bigint | boolean | null | Uint8Array>;

// bun:sqlite accepts a single object of named bindings at runtime, but the
// bundled type definitions only describe positional bindings. These helpers
// keep that discrepancy in one place instead of scattered across callers.

/**
 * Execute a statement and return its result metadata.
 */
export function dbRun(sql: string, params?: SqlParams): { changes: number; lastInsertRowid: number | bigint } {
  const db = getDb() as any;
  return params ? db.run(sql, params) : db.run(sql);
}

/**
 * Run a query and return every row.
 */
export function dbAll<T = any>(sql: string, params?: SqlParams): T[] {
  const statement = getDb().query(sql) as any;
  return (params ? statement.all(params) : statement.all()) as T[];
}

/**
 * Run a query and return the first row, or null.
 */
export function dbGet<T = any>(sql: string, params?: SqlParams): T | null {
  const statement = getDb().query(sql) as any;
  const row = params ? statement.get(params) : statement.get();
  return (row ?? null) as T | null;
}

/**
 * Prepare a statement whose `run` accepts named bindings.
 */
export function dbPrepare(sql: string): { run: (params: SqlParams) => void } {
  const statement = getDb().prepare(sql) as any;
  return {
    run: (params: SqlParams) => {
      statement.run(params);
    },
  };
}

/**
 * Run `work` inside a single transaction.
 */
export function dbTransaction<T extends unknown[]>(work: (...args: T) => void): (...args: T) => void {
  return getDb().transaction(work) as unknown as (...args: T) => void;
}

/**
 * Close the shared handle. Used by tests and graceful shutdown.
 */
export function closeDb(): void {
  if (database) {
    database.close();
    database = null;
    resolvedPath = null;
  }
}
