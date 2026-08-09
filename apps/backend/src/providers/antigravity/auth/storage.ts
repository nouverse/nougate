import { type AntigravityAccount, type SelectionStrategy } from '@/providers/antigravity/auth/types';
import { resolveStateFile } from '@/core/paths';
import { createStateFileWriter } from '@/core/state-file';

// Accounts live in the data directory (the Docker volume, or ./data locally)
// so every launch method reads and writes the same file.
const DEFAULT_PATH = resolveStateFile('providers', 'antigravity', 'accounts.json');

const LEGACY_PATH = resolveStateFile('antigravity-accounts.json');

const ACCOUNTS_FILE = process.env.ACCOUNTS_FILE || DEFAULT_PATH;

interface StorageFormat {
  accounts: AntigravityAccount[];
  strategy?: SelectionStrategy;
}

export async function loadConfig(): Promise<StorageFormat> {
  try {
    const candidatePaths = [ACCOUNTS_FILE, LEGACY_PATH].filter(
      (path, index, list) => list.indexOf(path) === index,
    );

    for (const path of candidatePaths) {
      const file = Bun.file(path);
      if (!(await file.exists())) {
        continue;
      }

      const data = await file.json();
      if (Array.isArray(data)) {
        // Migration from old format
        return { accounts: data, strategy: "hybrid" };
      }
      return data;
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
