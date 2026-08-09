import { type AntigravityAccount, type SelectionStrategy } from '@/providers/antigravity/auth/types';
import { dataPath } from '@/core/paths';
import { createStateFileWriter } from '@/core/state-file';

// Accounts live in the data directory (the Docker volume, or ./data locally)
// so every launch method reads and writes the same file.
const DEFAULT_PATH = dataPath('providers', 'antigravity', 'accounts.json');

const ACCOUNTS_FILE = process.env.ACCOUNTS_FILE || DEFAULT_PATH;

interface StorageFormat {
  accounts: AntigravityAccount[];
  strategy?: SelectionStrategy;
}

export async function loadConfig(): Promise<StorageFormat> {
  try {
    const file = Bun.file(ACCOUNTS_FILE);
    if (await file.exists()) {
      return await file.json();
    }
  } catch (e) {
    console.error("Failed to load accounts:", e);
  }
  return { accounts: [] };
}

// Kept for backward compatibility but deprecated
export async function loadAccounts(): Promise<AntigravityAccount[]> {
  return (await loadConfig()).accounts;
}

const writer = createStateFileWriter<StorageFormat>(ACCOUNTS_FILE, {
  label: 'antigravity accounts',
});

/**
 * Persist accounts.
 *
 * Routine saves are coalesced: scoring updates on every request, but ~74% of
 * this file is a quota snapshot that rarely changes, so writing it per request
 * is almost entirely wasted I/O. Pass `immediate` whenever credentials change
 * (sign-in, token refresh, removal) so those are durable straight away.
 */
export async function saveConfig(
  config: StorageFormat,
  options: { immediate?: boolean } = {},
): Promise<void> {
  writer.schedule(config);
  if (options.immediate) {
    writer.flush();
  }
}

/**
 * Write any pending account state to disk right now.
 */
export function flushConfig(): void {
  writer.flush();
}
