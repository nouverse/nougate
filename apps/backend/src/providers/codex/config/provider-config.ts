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
  /**
   * The Codex CLI version this gateway claims to be, sent as `version` and inside the User-Agent.
   *
   * Not cosmetic, and not a version pin: the upstream **gates models on it**. Claiming 0.136.0 gets
   * `gpt-5.6-terra` and `gpt-5.6-luna` refused with "requires a newer version of Codex. Please
   * upgrade to the latest app or CLI" — a message aimed at a person running the real CLI, which
   * reads here like the model does not exist.
   *
   * Configurable because it goes stale on OpenAI's schedule, not on this gateway's: a model released
   * next month will be gated behind a version released next month, and an operator should be able to
   * follow that by editing one field rather than waiting for a release.
   */
  cliVersion: string;
}

const DEFAULTS: CodexConfig = {
  baseUrl: 'https://chatgpt.com/backend-api/codex/responses',
  features: DEFAULT_JITTER_CONFIG,
  // Chosen by probing a live account, not read off a release page: 0.136.0 is refused for the newer
  // models and this is not. Track the real CLI when you know its version — see `cliVersion`.
  cliVersion: '0.190.0',
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
