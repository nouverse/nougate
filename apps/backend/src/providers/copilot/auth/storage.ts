import { existsSync } from 'fs';
import { mkdir } from 'fs/promises';
import { dirname, join } from 'path';

import { type CopilotAccount } from '@/providers/copilot/auth/types';

// In Docker, /app/data/ is the writable volume. Fallback to cwd for local dev.
const DEFAULT_PATH = existsSync("/app/data")
  ? '/app/data/providers/copilot/accounts.json'
  : join(process.cwd(), 'providers', 'copilot', 'accounts.json');

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
      const data = await file.json();
      if (Array.isArray(data)) {
        return { accounts: data, strategy: 'hybrid' };
      }
      return data;
    }
  } catch (e) {
    console.error("Failed to load Copilot accounts:", e);
  }
  return { accounts: [], strategy: 'hybrid' };
}

export async function saveConfig(config: StorageFormat): Promise<void> {
  try {
    await mkdir(dirname(ACCOUNTS_FILE), { recursive: true });
    await Bun.write(ACCOUNTS_FILE, JSON.stringify(config, null, 2));
  } catch (e) {
    console.error("Failed to save Copilot accounts:", e);
  }
}
