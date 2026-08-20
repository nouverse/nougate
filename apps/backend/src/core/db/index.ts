import { Database } from 'bun:sqlite';
import { SQL } from 'bun';
import { sql } from 'drizzle-orm';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { drizzle as drizzleSqlite } from 'drizzle-orm/bun-sqlite';
import { drizzle as drizzlePg } from 'drizzle-orm/bun-sql';

import { dataPath } from '@/core/paths';
import * as sqliteSchema from '@/core/db/schema/sqlite';
import * as pgSchema from '@/core/db/schema/pg';

export type Dialect = 'sqlite' | 'postgres';

/**
 * Which database backs this process.
 *
 * `DB_URL` decides: empty (or a sqlite:/file: path) keeps the embedded SQLite
 * file, a postgres URL connects there instead. Nothing else in the codebase
 * branches on this — the two schemas are structurally identical, and every
 * query is written with `await`, which both drivers accept.
 */
export function resolveDialect(url = process.env.DB_URL): Dialect {
  const trimmed = (url ?? '').trim();

  if (!trimmed || trimmed.startsWith('sqlite:') || trimmed.startsWith('file:')) {
    return 'sqlite';
  }
  if (trimmed.startsWith('postgres://') || trimmed.startsWith('postgresql://')) {
    return 'postgres';
  }

  throw new Error(
    `[DB] Unsupported DB_URL "${trimmed}". Use postgres://…, sqlite:<path>, ` +
      'or leave it empty for the built-in SQLite file.',
  );
}

/**
 * Where the SQLite file lives, when SQLite is the backend.
 */
export function resolveSqlitePath(url = process.env.DB_URL): string {
  const trimmed = (url ?? '').trim();

  if (trimmed.startsWith('sqlite:') || trimmed.startsWith('file:')) {
    const path = trimmed.replace(/^(sqlite:\/\/|sqlite:|file:\/\/|file:)/, '');
    if (path) {
      return path;
    }
  }

  return process.env.NOUGATE_DB_PATH || dataPath('nougate.db');
}

export const dialect: Dialect = resolveDialect();

/**
 * The active tables.
 *
 * Typed as the SQLite variant so call sites see one concrete set of types. The
 * Postgres schema is built to match column-for-column, and a test asserts the
 * two stay in step — this cast is the single point where they meet.
 */
export const t = (dialect === 'postgres'
  ? pgSchema.schema
  : sqliteSchema.schema) as unknown as typeof sqliteSchema.schema;

/**
 * Bucket an epoch-millisecond column into an hour or day label. The only query
 * fragment the two databases genuinely disagree on.
 */
export const timeBucket = dialect === 'postgres' ? pgSchema.timeBucket : sqliteSchema.timeBucket;

type Db = ReturnType<typeof drizzleSqlite<typeof sqliteSchema.schema>>;

let database: Db | null = null;
let sqliteHandle: Database | null = null;
let pgClient: SQL | null = null;
let target = '(not opened)';

function openSqlite(): Db {
  const path = resolveSqlitePath();
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  sqliteHandle = new Database(path, { create: true });

  // WAL keeps the metrics writer from blocking dashboard reads, and NORMAL sync
  // is the right trade-off for telemetry we can afford to lose a second of.
  sqliteHandle.exec('PRAGMA journal_mode = WAL');
  sqliteHandle.exec('PRAGMA synchronous = NORMAL');
  sqliteHandle.exec('PRAGMA foreign_keys = ON');
  sqliteHandle.exec('PRAGMA busy_timeout = 5000');

  target = path;
  return drizzleSqlite(sqliteHandle, { schema: sqliteSchema.schema });
}

function openPostgres(): Db {
  const url = (process.env.DB_URL ?? '').trim();
  pgClient = new SQL(url, { max: 10, idleTimeout: 20, connectionTimeout: 10 });

  // Redact credentials before this reaches a log line.
  target = url.replace(/\/\/[^@]*@/, '//***@');
  return drizzlePg(pgClient, { schema: pgSchema.schema }) as unknown as Db;
}

/**
 * The shared database handle, opened on first use.
 */
export function getDb(): Db {
  if (!database) {
    database = dialect === 'postgres' ? openPostgres() : openSqlite();
  }
  return database;
}

/**
 * The raw bun:sqlite handle, for the few places that need SQLite directly.
 * Null when Postgres is the backend.
 */
export function getSqliteHandle(): Database | null {
  getDb();
  return sqliteHandle;
}

export function getDbTarget(): string {
  return target;
}

/**
 * Create any missing tables and indexes.
 *
 * Plain `IF NOT EXISTS` DDL run on every boot rather than a migration history:
 * it is idempotent, needs no state table, and the schema is small enough that
 * keeping the SQL readable is worth more than a migration log.
 */
export async function initDb(): Promise<void> {
  const db = getDb();
  const { ddl } =
    dialect === 'postgres'
      ? await import('@/core/db/ddl/pg')
      : await import('@/core/db/ddl/sqlite');

  for (const statement of ddl) {
    if (dialect === 'postgres') {
      await (db as unknown as { execute: (q: unknown) => Promise<unknown> }).execute(statement);
    } else {
      sqliteHandle!.exec(statement);
    }
  }

  await addMissingColumns();

  console.log(`[DB] ${dialect} ready at ${target}`);
}

/**
 * Columns added to an existing table after it was first created.
 *
 * `CREATE TABLE IF NOT EXISTS` is a no-op once the table exists, so a new column
 * never reaches a database that is already in use. The alternative was telling
 * people to delete `nougate.db`, which throws away their usage history for the
 * sake of one nullable column.
 *
 * Strictly additive and nullable: this is not a migration framework, and must
 * not become one. Anything that rewrites or drops data needs a real migration
 * story, not an entry here.
 */
const ADDED_COLUMNS: Array<{ table: string; column: string; type: string }> = [
  { table: 'token_usage_logs', column: 'compression_breakdown', type: 'TEXT' },
  { table: 'custom_providers', column: 'jitter_enabled', type: 'INTEGER' },
  { table: 'custom_providers', column: 'jitter_min_ms', type: 'INTEGER' },
  { table: 'custom_providers', column: 'jitter_max_ms', type: 'INTEGER' },
];

async function addMissingColumns(): Promise<void> {
  for (const { table, column, type } of ADDED_COLUMNS) {
    try {
      if (dialect === 'postgres') {
        await (getDb() as unknown as { execute: (q: unknown) => Promise<unknown> }).execute(
          sql.raw(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${type}`),
        );
        continue;
      }

      // SQLite has no ADD COLUMN IF NOT EXISTS, so ask before adding.
      const existing = sqliteHandle!.query(`PRAGMA table_info(${table})`).all() as Array<{
        name: string;
      }>;
      if (existing.some((info) => info.name === column)) {
        continue;
      }

      sqliteHandle!.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      console.log(`[DB] Added ${table}.${column}`);
    } catch (error) {
      // A failure here leaves the column missing, which surfaces loudly on the
      // first query rather than corrupting anything.
      console.error(`[DB] Could not add ${table}.${column}:`, error);
    }
  }
}

/**
 * Close the connection. Used by tests and graceful shutdown.
 */
export async function closeDb(): Promise<void> {
  if (sqliteHandle) {
    sqliteHandle.close();
    sqliteHandle = null;
  }
  if (pgClient) {
    await pgClient.end();
    pgClient = null;
  }
  database = null;
  target = '(not opened)';
}
