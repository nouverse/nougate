/**
 * Provider-level settings — the parts an operator tunes without touching a credential.
 *
 * Stored beside the accounts rather than in the global proxy config, for the same reason every other
 * provider does it: a setting that only means something to one upstream does not belong in a file
 * every upstream reads.
 */

import { dataPath } from '@/core/paths';
import { createStateFileWriter } from '@/core/state-file';
import { DEFAULT_JITTER_CONFIG, type JitterConfig } from '@/core/jitter';

const CONFIG_FILE =
  process.env.CLAUDE_CODE_CONFIG_FILE || dataPath('providers', 'claude-code', 'config.json');

export interface ClaudeCodeConfig {
  /** Where requests go. Overridable so a proxy or a regional endpoint can be pointed at. */
  baseUrl: string;
  features: Partial<JitterConfig>;
  /**
   * A command that prints a fresh OAuth access token on stdout, and nothing else.
   *
   * Empty by default, and that default is deliberate: this gateway shelling out to an arbitrary
   * string is a capability, not a convenience, so it stays off until an operator writes one in.
   *
   * It exists because an OAuth access token lives hours, not months. Without it a subscription-backed
   * credential dies overnight and the provider is a manual re-paste every morning. The supported way
   * to produce one is Anthropic's own CLI, which refreshes on demand:
   *
   *     ant auth print-credentials --access-token
   *
   * Run on a 401, once, before the credential is given up on. Nothing an inbound request controls
   * reaches this string — it is read from this file and nowhere else.
   */
  refreshCommand: string;
}

const DEFAULTS: ClaudeCodeConfig = {
  baseUrl: 'https://api.anthropic.com',
  features: DEFAULT_JITTER_CONFIG,
  refreshCommand: '',
};

let current: ClaudeCodeConfig = { ...DEFAULTS };

export async function loadClaudeCodeConfig(): Promise<void> {
  try {
    const file = Bun.file(CONFIG_FILE);
    if (await file.exists()) {
      current = { ...DEFAULTS, ...(await file.json()) };
    }
  } catch (error) {
    console.error('[claude-code] could not read config, using defaults:', error);
    current = { ...DEFAULTS };
  }
}

export function getClaudeCodeConfig(): ClaudeCodeConfig {
  return current;
}

const writer = createStateFileWriter<ClaudeCodeConfig>(CONFIG_FILE, {
  label: 'claude-code config',
});

export async function updateClaudeCodeConfig(patch: Partial<ClaudeCodeConfig>): Promise<ClaudeCodeConfig> {
  current = { ...current, ...patch };
  writer.schedule(current);
  writer.flush();
  return current;
}
