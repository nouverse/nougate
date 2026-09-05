/**
 * Where the credentials live.
 *
 * The same data directory every other provider writes to, so one Docker volume carries all of them
 * and no launch method sees a different set. Coalesced through `createStateFileWriter` for the same
 * reason Antigravity does: health scores move on every request and the file is mostly credentials
 * that never change, so a write per request is almost entirely wasted I/O.
 *
 * `immediate` on anything that touches a credential — added, removed, invalidated, refreshed. A
 * coalesced write that loses a refreshed token to a restart costs the operator a manual re-paste,
 * which is exactly the friction this provider exists to avoid.
 */

import { dataPath } from '@/core/paths';
import { createStateFileWriter } from '@/core/state-file';
import type { ClaudeCodeAccount, SelectionStrategy } from './types';

/**
 * Resolved per call rather than captured at import.
 *
 * A module-level `const` reading the environment is evaluated once, when the file is first imported —
 * so an override set after that point is silently ignored, and every consumer in the process is
 * pinned to whichever path happened to be current at import time. That is a real bug in its own
 * right, and it is also what makes this module impossible to exercise twice in one test run.
 */
function accountsFile(): string {
  return (
    process.env.CLAUDE_CODE_ACCOUNTS_FILE || dataPath('providers', 'claude-code', 'accounts.json')
  );
}

/** One coalescing writer per path — see `saveConfig`. */
const writers = new Map<string, ReturnType<typeof createStateFileWriter<StorageFormat>>>();

function writerFor(path: string) {
  let writer = writers.get(path);
  if (!writer) {
    writer = createStateFileWriter<StorageFormat>(path, { label: 'claude-code accounts' });
    writers.set(path, writer);
  }
  return writer;
}

export interface StorageFormat {
  accounts: ClaudeCodeAccount[];
  strategy?: SelectionStrategy;
}

export async function loadConfig(): Promise<StorageFormat> {
  try {
    const file = Bun.file(accountsFile());
    if (await file.exists()) return await file.json();
  } catch (error) {
    // Reported, never thrown: a corrupt accounts file must not stop the gateway from booting and
    // serving every other provider. The operator sees an empty list and a log line saying why.
    console.error('[claude-code] could not read accounts file:', error);
  }
  return { accounts: [] };
}

export async function saveConfig(
  config: StorageFormat,
  options: { immediate?: boolean } = {},
): Promise<void> {
  const writer = writerFor(accountsFile());
  writer.schedule(config);
  if (options.immediate) writer.flush();
}

export function flushConfig(): void {
  writerFor(accountsFile()).flush();
}
