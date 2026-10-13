import { dataPath } from '@/core/paths';
import { createStateFileWriter } from '@/core/state-file';
import type { KiroAccountsFile } from './types';

// Accounts live in the data directory (the Docker volume, or ./data locally) so every launch
// method reads and writes the same file.
const ACCOUNTS_FILE = process.env.KIRO_ACCOUNTS_FILE || dataPath('providers', 'kiro', 'accounts.json');

export async function loadAccountsFile(): Promise<KiroAccountsFile> {
  try {
    const file = Bun.file(ACCOUNTS_FILE);
    if (await file.exists()) return (await file.json()) as KiroAccountsFile;
  } catch (error) {
    console.error('[kiro] could not read accounts:', error);
  }
  return { accounts: [], strategy: 'healthiest' };
}

const writer = createStateFileWriter<KiroAccountsFile>(ACCOUNTS_FILE, { label: 'kiro accounts' });

/**
 * Persist accounts. Routine scoring saves are coalesced; pass `immediate` when credentials change
 * so a restart can never lose them.
 */
export function saveAccountsFile(data: KiroAccountsFile, options: { immediate?: boolean } = {}): void {
  writer.schedule(data);
  if (options.immediate) writer.flush();
}
