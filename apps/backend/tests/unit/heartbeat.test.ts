/**
 * The gateway's one heartbeat (E15): usage rows and key counters written together, on 30 s inside a host and 5 s on its
 * own, nothing scheduled at idle, the write-ahead log folded home from the beat at most once an hour — and a shutdown
 * that writes what the beat holds.
 *
 * Inside Nouride this database shares an SD card with the daemon's, and its writes had three cadences of their own:
 * usage every 5 s, key counters every 30 s, and SQLite's autocheckpoint at whatever commit crossed 1000 pages.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Database } from 'bun:sqlite';

const STATE_DIR = mkdtempSync(join(tmpdir(), 'nougate-heartbeat-'));
const DB_PATH = join(STATE_DIR, 'heartbeat-test.db');
// Read when the database is opened, so it must be set before anything opens it.
process.env.NOUGATE_DB_PATH = DB_PATH;

const { loadProxyConfig } = await import('@/config/manager');
const { initDb, closeDb, getDb, t } = await import('@/core/db');
const heartbeat = await import('@/core/db/heartbeat');
const { tokenMetricsLogger } = await import('@/core/metrics/logger');
const keys = await import('@/auth/api-keys');
const { shutdown } = await import('@/boot');
const { eq, sql } = await import('drizzle-orm');

beforeAll(async () => {
  await loadProxyConfig();
  await initDb();
  await keys.initApiKeys();
  // Whatever an earlier file in this run left buffered goes now, so the beat below is this file's own.
  await heartbeat.beatNow();
});

afterAll(async () => {
  heartbeat.setBeatInterval(heartbeat.STANDALONE_BEAT_MS);
  await closeDb();
  rmSync(STATE_DIR, { recursive: true, force: true });
});

function logRow(model = 'gpt-4o') {
  tokenMetricsLogger.log({
    timestamp: Date.now(),
    clientId: 'nouride/agent',
    provider: 'copilot',
    model,
    fullModelName: `copilot:${model}`,
    protocol: 'openai',
    streamed: false,
    statusCode: 200,
    durationMs: 100,
    inputTokens: 10,
    outputTokens: 5,
    cachedInputTokens: 0,
    tokensSaved: 0,
    estimated: false,
    inputCost: 0,
    outputCost: 0,
    costSaved: 0,
    cacheCostSaved: 0,
  });
}

async function rowsFor(model: string): Promise<number> {
  const [row] = await getDb()
    .select({ n: sql<number>`count(*)` })
    .from(t.tokenUsageLogs)
    .where(eq(t.tokenUsageLogs.model, model));
  return Number(row?.n ?? 0);
}

/** The rows the database *file* holds, as a copy of it without its log reads them: what a checkpoint has moved home. */
function rowsInFileFor(model: string): number {
  const copy = join(STATE_DIR, `file-only-${Math.random().toString(36).slice(2)}.db`);
  copyFileSync(DB_PATH, copy);
  // Read-write: a WAL-mode file opened read-only wants the log the copy deliberately does not have.
  const db = new Database(copy);
  try {
    return (db.query('SELECT count(*) AS n FROM token_usage_logs WHERE model = ?').get(model) as { n: number }).n;
  } finally {
    db.close();
  }
}

/** The delays `armBeat` asks of `setTimeout`, while `run` runs. The timers themselves are cleared. */
function delaysOf(run: () => void): number[] {
  const real = globalThis.setTimeout;
  const delays: number[] = [];
  globalThis.setTimeout = ((handler: () => void, ms?: number) => {
    delays.push(ms ?? 0);
    return real(handler, 3_600_000);
  }) as typeof setTimeout;
  try {
    run();
  } finally {
    globalThis.setTimeout = real;
  }
  return delays;
}

describe('the heartbeat', () => {
  test('nothing is written before the beat, and one beat writes the usage rows and the key counters together', async () => {
    const key = await keys.createApiKey({ name: 'beat' });
    logRow('one-beat');
    keys.touchApiKey(key.id);
    keys.touchApiKey(key.id);
    expect(heartbeat.beatPending()).toBe(true);
    expect(await rowsFor('one-beat')).toBe(0);

    await heartbeat.beatNow();
    expect(await rowsFor('one-beat')).toBe(1);
    const [stored] = await getDb().select().from(t.apiKeys).where(eq(t.apiKeys.id, key.id));
    expect(stored?.requestCount).toBe(2);
    expect(heartbeat.beatPending()).toBe(false);
  });

  test('an idle gateway sets no beat, and a burst sets one, once, at the interval it was given', async () => {
    await heartbeat.beatNow();
    expect(heartbeat.beatPending()).toBe(false);

    heartbeat.setBeatInterval(heartbeat.HOSTED_BEAT_MS);
    const delays = delaysOf(() => {
      logRow('burst');
      logRow('burst');
      keys.touchApiKey('no-such-key');
    });
    expect(delays).toEqual([30_000]);

    heartbeat.setBeatInterval(heartbeat.STANDALONE_BEAT_MS);
    await heartbeat.beatNow();
    expect(delaysOf(() => logRow('burst'))).toEqual([5_000]);
    await heartbeat.beatNow();
  });

  test('the log is folded into the database file from the beat, at most once an hour', async () => {
    const start = Date.now() + 10 * 60 * 60 * 1000;
    // A fold now, so the hour is counted from here whatever ran before this file.
    await heartbeat.beat(start);

    logRow('fold');
    await heartbeat.beat(start + 30 * 60 * 1000);
    expect(await rowsFor('fold')).toBe(1);
    // Written, and still only in the log.
    expect(rowsInFileFor('fold')).toBe(0);

    await heartbeat.beat(start + 61 * 60 * 1000);
    expect(rowsInFileFor('fold')).toBe(1);
  });

  /** Inside Nouride this timer runs in the daemon's process, where an exception nothing catches ends the daemon. */
  test('a buffer whose write throws is logged, the beat does not, and the buffers after it are still written', async () => {
    const written: string[] = [];
    const removals = [
      heartbeat.onBeat(async () => {
        throw new Error('this buffer cannot be written');
      }),
      heartbeat.onBeat(() => {
        throw new Error('nor this one, before it has a promise');
      }),
      heartbeat.onBeat(async () => {
        written.push('the next buffer');
      }),
    ];
    try {
      logRow('beside-a-throw');
      await heartbeat.beatNow();
      expect(written).toEqual(['the next buffer']);
      expect(await rowsFor('beside-a-throw')).toBe(1);
    } finally {
      for (const remove of removals) remove();
    }
  });

  test("a shutdown writes what the beat holds before the database closes", async () => {
    logRow('held-at-shutdown');
    expect(heartbeat.beatPending()).toBe(true);
    await shutdown();
    expect(heartbeat.beatPending()).toBe(false);
    // Opened again: the row is in the database, not lost with the process.
    expect(await rowsFor('held-at-shutdown')).toBe(1);
  });
});

/** A gateway on its own answers SIGTERM itself (`standalone.ts`), and writes what the beat holds before it goes. */
describe('a gateway on its own', () => {
  test("a gateway on its own writes what the beat holds on SIGTERM, then exits", () => {
    const home = mkdtempSync(join(tmpdir(), 'nougate-standalone-'));
    const src = (rel: string) => JSON.stringify(join(import.meta.dir, '../../src', rel));
    const row = {
      timestamp: Date.now(), clientId: 'c', provider: 'p', model: 'on-sigterm', fullModelName: 'p:on-sigterm',
      protocol: 'openai', streamed: false, statusCode: 200, durationMs: 1, inputTokens: 1, outputTokens: 1,
      cachedInputTokens: 0, tokensSaved: 0, estimated: false, inputCost: 0, outputCost: 0, costSaved: 0, cacheCostSaved: 0,
    };
    try {
      const script = [
        `const { initDb } = await import(${src('core/db/index.ts')});`,
        `const { tokenMetricsLogger } = await import(${src('core/metrics/logger.ts')});`,
        `const { shutDownOnSignals } = await import(${src('standalone.ts')});`,
        `await initDb();`,
        `tokenMetricsLogger.log(${JSON.stringify(row)});`,
        `shutDownOnSignals();`,
        `process.kill(process.pid, "SIGTERM");`,
        // Only reached when nothing answered the signal by exiting.
        `await new Promise((resolve) => setTimeout(resolve, 5000));`,
        `process.exit(9);`,
      ].join('\n');
      const run = spawnSync(process.execPath, ['-e', script], {
        cwd: join(import.meta.dir, '../..'),
        env: { ...process.env, NOUGATE_HOME: home, NOUGATE_DB_PATH: join(home, 'n.db') },
        encoding: 'utf8',
        timeout: 30_000,
      });
      expect(run.status).toBe(0);
      const db = new Database(join(home, 'n.db'));
      try {
        expect((db.query("SELECT count(*) AS n FROM token_usage_logs WHERE model = 'on-sigterm'").get() as { n: number }).n).toBe(1);
      } finally {
        db.close();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
