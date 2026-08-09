import { type CopilotAccount } from '@/providers/copilot/auth/types';
import { dataPath } from '@/core/paths';
import { createStateFileWriter } from '@/core/state-file';

// Accounts live in the data directory (the Docker volume, or ./data locally)
// so every launch method reads and writes the same file.
const DEFAULT_PATH = dataPath('providers', 'copilot', 'accounts.json');

const ACCOUNTS_FILE = process.env.COPILOT_ACCOUNTS_FILE || DEFAULT_PATH;

export type SelectionStrategy = 'sticky' | 'round-robin' | 'hybrid' | 'random' | 'least-used';

interface StorageFormat {
  accounts: CopilotAccount[];
  strategy?: SelectionStrategy;
}

export async function loadConfig(): Promise<StorageFormat> {
  try {
    const file = Bun.file(ACCOUNTS_FILE);
    if (await file.exists()) {
      return await file.json();
    }
  } catch (e) {
    console.error("Failed to load Copilot accounts:", e);
  }
  return { accounts: [], strategy: 'hybrid' };
}

const writer = createStateFileWriter<StorageFormat>(ACCOUNTS_FILE, {
  label: 'copilot accounts',
});

/**
 * Persist accounts. Routine scoring saves are coalesced; pass `immediate` when
 * credentials change so those are durable straight away.
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
