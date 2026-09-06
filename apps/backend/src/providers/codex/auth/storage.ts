/**
 * Where Codex credentials live on disk.
 *
 * Same pattern as cc: atomic writes via `createStateFileWriter`, immediate flush on
 * credential changes, coalesced for health score updates.
 */

import { dataPath } from '@/core/paths';
import { createStateFileWriter } from '@/core/state-file';
import type { CodexAccount, SelectionStrategy } from './types';

function accountsFile(): string {
  return (
    process.env.CODEX_ACCOUNTS_FILE || dataPath('providers', 'codex', 'accounts.json')
  );
}

const writers = new Map<string, ReturnType<typeof createStateFileWriter<StorageFormat>>>();

function writerFor(path: string) {
  let writer = writers.get(path);
  if (!writer) {
    writer = createStateFileWriter<StorageFormat>(path, { label: 'codex accounts' });
    writers.set(path, writer);
  }
  return writer;
}

export interface StorageFormat {
  accounts: CodexAccount[];
  strategy?: SelectionStrategy;
}

export async function loadConfig(): Promise<StorageFormat> {
  try {
    const file = Bun.file(accountsFile());
    if (await file.exists()) return await file.json();
  } catch (error) {
    console.error('[codex] could not read accounts file:', error);
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
