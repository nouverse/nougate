import { mkdirSync, renameSync, rmSync, writeFileSync } from 'fs';
import { dirname } from 'path';

/**
 * Durable, coalesced writer for a JSON state file.
 *
 * Two problems it solves for files that are updated on the request path:
 *
 * 1. **Torn writes.** Writing straight to the destination truncates it first,
 *    so a crash — or two overlapping writes — can leave a half-written file.
 *    For provider accounts that file holds the OAuth refresh tokens, and losing
 *    it means re-authenticating every account. Writing to a sibling temp file
 *    and renaming makes the swap atomic: readers see either the old file or the
 *    new one, never a partial one.
 *
 * 2. **Write amplification.** Account scoring updates on every request, but the
 *    bulk of the file is a quota snapshot that changes rarely. Coalescing turns
 *    a burst of saves into one write.
 *
 * Anything that changes credentials should still use `flush()` so it is durable
 * immediately rather than sitting in the debounce window.
 */
export interface StateFileWriter<T> {
  /** Queue a write, coalescing with any already pending. */
  schedule(value: T): void;
  /** Write immediately, cancelling any pending write. */
  flush(): void;
  /** True while a write is queued. */
  isPending(): boolean;
}

export interface StateFileOptions {
  /** How long to coalesce rapid updates. */
  debounceMs?: number;
  /** Label used in error logs. */
  label?: string;
}

const DEFAULT_DEBOUNCE_MS = 1000;

/** Every writer created here, so shutdown can drain them all. */
const registry = new Set<{ flush: () => void }>();
let shutdownHooked = false;

/**
 * Write a value to disk atomically: temp file, then rename over the target.
 */
export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });

  // The temp file must sit on the same filesystem as the target, or rename
  // stops being atomic — so it goes right next to it.
  const tempPath = `${path}.tmp`;

  try {
    writeFileSync(tempPath, JSON.stringify(value, null, 2));
    renameSync(tempPath, path);
  } catch (error) {
    // Never leave a stray temp file behind for the next run to puzzle over.
    rmSync(tempPath, { force: true });
    throw error;
  }
}

/**
 * Flush every registered writer. Called on shutdown so a debounced write is
 * never lost to a restart.
 */
export function flushAllStateFiles(): void {
  for (const writer of registry) {
    writer.flush();
  }
}

/**
 * A last flush when the process exits, whoever ends it.
 *
 * 'exit' only — never a signal. A handler for SIGINT or SIGTERM is the process owner's to install: a gateway on its
 * own does in `standalone.ts`, and inside a host the host does. Installed here, one that called `process.exit` ran first in
 * Nouride's router editions — it was registered when this module loaded, before the daemon's — and ended the daemon
 * before its own shutdown could save a turn. `shutdown()` in `boot.ts` is what an owner calls.
 */
function installShutdownHook(): void {
  if (shutdownHooked) {
    return;
  }
  shutdownHooked = true;

  // 'exit' must stay synchronous, which is why the write path uses the sync fs
  // calls rather than Bun.write.
  process.on('exit', flushAllStateFiles);
}

/**
 * Create a debounced, atomic writer for one file.
 */
export function createStateFileWriter<T>(
  path: string,
  options: StateFileOptions = {},
): StateFileWriter<T> {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const label = options.label ?? path;

  let pending: { value: T } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const write = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!pending) {
      return;
    }

    const { value } = pending;
    pending = null;

    try {
      writeJsonAtomic(path, value);
    } catch (error) {
      console.error(`[StateFile] Failed to save ${label}:`, error);
    }
  };

  const writer: StateFileWriter<T> = {
    schedule(value: T) {
      // Keep only the newest value; older ones are already superseded.
      pending = { value };
      if (!timer) {
        timer = setTimeout(write, debounceMs);
        timer.unref?.();
      }
    },
    flush: write,
    isPending: () => pending !== null,
  };

  registry.add(writer);
  installShutdownHook();

  return writer;
}
