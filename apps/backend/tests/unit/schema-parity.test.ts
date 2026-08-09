import { describe, expect, test } from 'bun:test';
import { getTableColumns, getTableName } from 'drizzle-orm';

import * as sqliteSchema from '@/core/db/schema/sqlite';
import * as pgSchema from '@/core/db/schema/pg';

/**
 * Drizzle types its tables per dialect, so the SQLite and Postgres schemas are
 * the same tables written twice. That duplication is the price of switching
 * backends with `DB_URL` alone — and it only stays safe if the two cannot
 * silently drift.
 *
 * Every query in the app is written against the SQLite types and executed
 * against whichever schema is active, so a column that exists in one and not
 * the other is a runtime failure on exactly one backend. These tests turn that
 * into a failing build instead.
 */

const TABLE_KEYS = Object.keys(sqliteSchema.schema) as Array<keyof typeof sqliteSchema.schema>;

describe('schema parity between dialects', () => {
  test('both dialects define the same tables', () => {
    expect(Object.keys(pgSchema.schema).sort()).toEqual(Object.keys(sqliteSchema.schema).sort());
  });

  test('every table maps to the same SQL table name', () => {
    for (const key of TABLE_KEYS) {
      const sqliteName = getTableName(sqliteSchema.schema[key] as never);
      const pgName = getTableName(pgSchema.schema[key] as never);
      expect(`${key}: ${pgName}`).toBe(`${key}: ${sqliteName}`);
    }
  });

  test.each(TABLE_KEYS)('%s has identical columns in both dialects', (key) => {
    const sqliteColumns = getTableColumns(sqliteSchema.schema[key] as never);
    const pgColumns = getTableColumns(pgSchema.schema[key] as never);

    // Property names drive the query code; SQL names drive the DDL. Both matter.
    expect(Object.keys(pgColumns).sort()).toEqual(Object.keys(sqliteColumns).sort());

    const sqlName = (columns: Record<string, { name: string }>) =>
      Object.entries(columns)
        .map(([property, column]) => `${property} -> ${column.name}`)
        .sort();
    expect(sqlName(pgColumns as never)).toEqual(sqlName(sqliteColumns as never));
  });

  test.each(TABLE_KEYS)('%s agrees on nullability and defaults', (key) => {
    const sqliteColumns = getTableColumns(sqliteSchema.schema[key] as never) as Record<string, any>;
    const pgColumns = getTableColumns(pgSchema.schema[key] as never) as Record<string, any>;

    for (const property of Object.keys(sqliteColumns)) {
      const a = sqliteColumns[property];
      const b = pgColumns[property];

      expect(`${key}.${property} notNull=${b.notNull}`).toBe(
        `${key}.${property} notNull=${a.notNull}`,
      );
      expect(`${key}.${property} default=${JSON.stringify(b.default)}`).toBe(
        `${key}.${property} default=${JSON.stringify(a.default)}`,
      );
    }
  });

  test('values round-trip as the same JavaScript types', () => {
    // Postgres could reasonably store these as timestamp/boolean/numeric, but
    // then the same row would come back as a different JS type depending on the
    // backend. Every column is pinned to the same dataType on both sides.
    for (const key of TABLE_KEYS) {
      const sqliteColumns = getTableColumns(sqliteSchema.schema[key] as never) as Record<string, any>;
      const pgColumns = getTableColumns(pgSchema.schema[key] as never) as Record<string, any>;

      for (const property of Object.keys(sqliteColumns)) {
        expect(`${key}.${property}: ${pgColumns[property].dataType}`).toBe(
          `${key}.${property}: ${sqliteColumns[property].dataType}`,
        );
      }
    }
  });
});

describe('DB_URL routing', () => {
  test('picks the right backend for each URL shape', async () => {
    const { resolveDialect } = await import('@/core/db');

    expect(resolveDialect('')).toBe('sqlite');
    expect(resolveDialect('   ')).toBe('sqlite');
    expect(resolveDialect('sqlite:/tmp/x.db')).toBe('sqlite');
    expect(resolveDialect('file:/tmp/x.db')).toBe('sqlite');
    expect(resolveDialect('postgres://u:p@h:5432/db')).toBe('postgres');
    expect(resolveDialect('postgresql://u:p@h:5432/db')).toBe('postgres');
  });

  test('reads DB_URL from the environment when no argument is given', async () => {
    const { resolveDialect } = await import('@/core/db');
    const original = process.env.DB_URL;

    try {
      delete process.env.DB_URL;
      expect(resolveDialect()).toBe('sqlite');

      process.env.DB_URL = 'postgres://u:p@h:5432/db';
      expect(resolveDialect()).toBe('postgres');
    } finally {
      if (original === undefined) {
        delete process.env.DB_URL;
      } else {
        process.env.DB_URL = original;
      }
    }
  });

  test('rejects a URL it cannot serve, rather than silently using SQLite', async () => {
    const { resolveDialect } = await import('@/core/db');

    // Falling back would look like it worked while writing to the wrong place.
    expect(() => resolveDialect('mysql://u:p@h:3306/db')).toThrow(/Unsupported DB_URL/);
    expect(() => resolveDialect('redis://localhost')).toThrow(/Unsupported DB_URL/);
  });

  test('resolves the SQLite file path from the URL when given one', async () => {
    const { resolveSqlitePath } = await import('@/core/db');

    expect(resolveSqlitePath('sqlite:/tmp/custom.db')).toBe('/tmp/custom.db');
    expect(resolveSqlitePath('file:///tmp/other.db')).toBe('/tmp/other.db');
  });

  test('falls back to NOUGATE_DB_PATH, then the data directory', async () => {
    const { resolveSqlitePath } = await import('@/core/db');
    const original = process.env.NOUGATE_DB_PATH;

    try {
      process.env.NOUGATE_DB_PATH = '/tmp/explicit-override.db';
      expect(resolveSqlitePath('')).toBe('/tmp/explicit-override.db');

      delete process.env.NOUGATE_DB_PATH;
      expect(resolveSqlitePath('')).toContain('data/nougate.db');
    } finally {
      // Other suites in this process rely on the override staying put.
      if (original === undefined) {
        delete process.env.NOUGATE_DB_PATH;
      } else {
        process.env.NOUGATE_DB_PATH = original;
      }
    }
  });
});
