import { existsSync } from 'fs';
import { mkdir } from 'fs/promises';
import { dirname, join } from 'path';

import { type AntigravityAccount, type SelectionStrategy } from '@/providers/antigravity/auth/types';

// In Docker, /app/data/ is the writable volume. Fallback to cwd for local dev.
const DEFAULT_PATH = existsSync("/app/data")
  ? '/app/data/providers/antigravity/accounts.json'
  : join(process.cwd(), 'providers', 'antigravity', 'accounts.json');

const LEGACY_PATH = existsSync('/app/data')
  ? '/app/data/antigravity-accounts.json'
  : join(process.cwd(), 'antigravity-accounts.json');

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

export async function saveConfig(config: StorageFormat): Promise<void> {
  try {
    await mkdir(dirname(ACCOUNTS_FILE), { recursive: true });
    await Bun.write(ACCOUNTS_FILE, JSON.stringify(config, null, 2));
  } catch (e) {
    console.error("Failed to save accounts:", e);
  }
}
