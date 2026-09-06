/**
 * Codex provider-level settings — operator-tunable configuration.
 *
 * Stored beside the accounts. The Codex default instructions are injected when the
 * client sends no instructions.
 */

import { dataPath } from '@/core/paths';
import { createStateFileWriter } from '@/core/state-file';
import { DEFAULT_JITTER_CONFIG, type JitterConfig } from '@/core/jitter';

const CONFIG_FILE =
  process.env.CODEX_CONFIG_FILE || dataPath('providers', 'codex', 'config.json');

export interface CodexConfig {
  /** Where requests go. Defaults to the Codex Responses API endpoint. */
  baseUrl: string;
  features: Partial<JitterConfig>;
}

const DEFAULTS: CodexConfig = {
  baseUrl: 'https://chatgpt.com/backend-api/codex/responses',
  features: DEFAULT_JITTER_CONFIG,
};

let current: CodexConfig = { ...DEFAULTS };

export async function loadCodexConfig(): Promise<void> {
  try {
    const file = Bun.file(CONFIG_FILE);
    if (await file.exists()) {
      current = { ...DEFAULTS, ...(await file.json()) };
    }
  } catch (error) {
    console.error('[codex] could not read config, using defaults:', error);
    current = { ...DEFAULTS };
  }
}

export function getCodexConfig(): CodexConfig {
  return current;
}

const writer = createStateFileWriter<CodexConfig>(CONFIG_FILE, {
  label: 'codex config',
});

export async function updateCodexConfig(patch: Partial<CodexConfig>): Promise<CodexConfig> {
  current = { ...current, ...patch };
  writer.schedule(current);
  writer.flush();
  return current;
}
