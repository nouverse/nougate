/**
 * One moment for what the gateway writes on a timer (E15): the buffered usage rows, the API keys' counters, and the
 * write-ahead log's checkpoint after them.
 *
 * ## Why one
 *
 * Inside Nouride — a router Box, whose database sits on an SD card beside the daemon's own — this gateway's writes
 * kept three cadences of their own: usage rows every 5 s, key counters every 30 s, and SQLite's autocheckpoint at
 * whichever commit pushed the log past 1000 pages. A card wears with every write and every sync, so they are one beat:
 *
 * - **30 s inside a host, 5 s on its own.** A hosted gateway is one page of its host's dashboard, read by a person
 *   now and then; a gateway on its own keeps the cadence its metrics page was built for. `boot()` says which.
 * - **Set by the first thing buffered, and only then.** A beat is armed when a buffer gains an entry and fires once;
 *   with nothing buffered nothing is scheduled, so an idle gateway neither wakes nor writes. The two flush timers it
 *   replaces ran for the life of the process once anything had been logged.
 * - **The checkpoint rides the beat**, at most once an hour: the log folds an hour of rewrites of the same pages —
 *   the usage table's last page, its indexes, a key's row — into one write of each, at a moment this file chooses.
 *   SQLite's own autocheckpoint stays only as the bound for a burst, at 2000 pages as Nouride's database has it
 *   (`openSqlite` in `core/db/index.ts`).
 *
 * A host's shutdown writes what a beat holds — `shutdown()` in `boot.ts` — so a slower beat loses nothing to a
 * restart; a gateway on its own does the same on SIGTERM (`standalone.ts`).
 */

import { checkpointWal } from '@/core/db';

/** The beat of a gateway inside a host — Nouride's router editions. */
export const HOSTED_BEAT_MS = 30_000;
/** The beat of a gateway that is its own process. */
export const STANDALONE_BEAT_MS = 5_000;
/** How long the log may go unfolded while beats keep writing to it. */
const CHECKPOINT_EVERY_MS = 60 * 60 * 1000;

const flushers: Array<() => Promise<void>> = [];
let beatMs = STANDALONE_BEAT_MS;
let timer: ReturnType<typeof setTimeout> | null = null;
let lastCheckpointAt = Date.now();

/**
 * A buffer's flush, run on every beat — registered once, by the module that keeps the buffer. Returns its removal.
 *
 * Each runs on its own: one that throws is logged and the next still writes. Inside Nouride this timer runs in the
 * daemon's own process, where an exception nothing catches ends the daemon.
 */
export function onBeat(flush: () => Promise<void>): () => void {
  flushers.push(flush);
  return () => {
    const at = flushers.indexOf(flush);
    if (at >= 0) flushers.splice(at, 1);
  };
}

/** `HOSTED_BEAT_MS` or `STANDALONE_BEAT_MS` — `boot()`'s to say, before anything is buffered. */
export function setBeatInterval(ms: number): void {
  beatMs = ms;
}

/** The beat this gateway writes on — what a host can check its gateway was booted with. */
export function beatInterval(): number {
  return beatMs;
}

/** A beat one interval from now, unless one is already set. Called by a buffer as it gains an entry. */
export function armBeat(): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void beat().catch((error) => console.error('[Heartbeat] A beat failed:', error));
  }, beatMs);
  // Nothing buffered is worth holding a process open for: a host's shutdown and SIGTERM write it on the way out.
  timer.unref?.();
}

/** Whether a beat is set — what an idle gateway must not have. */
export function beatPending(): boolean {
  return timer !== null;
}

/** Everything buffered, written; then the log folded home when the last fold is an hour old. */
export async function beat(now: number = Date.now()): Promise<void> {
  for (const flush of flushers) {
    try {
      await flush();
    } catch (error) {
      console.error('[Heartbeat] A buffer could not be written:', error);
    }
  }
  if (now - lastCheckpointAt < CHECKPOINT_EVERY_MS) {
    return;
  }
  lastCheckpointAt = now;
  try {
    const result = checkpointWal();
    if (result?.busy) {
      console.warn('[Heartbeat] The write-ahead log was not fully checkpointed: a reader held it. The next beat tries again.');
      lastCheckpointAt = 0;
    }
  } catch (error) {
    console.warn('[Heartbeat] Could not checkpoint the write-ahead log:', error);
  }
}

/** The beat now, in place of the one set — a shutdown's, so nothing buffered is left behind. */
export async function beatNow(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  await beat();
}
