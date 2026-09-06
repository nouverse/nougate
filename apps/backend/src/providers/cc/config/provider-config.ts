/**
 * Provider-level settings — the parts an operator tunes without touching a credential.
 *
 * Stored beside the accounts rather than in the global proxy config, for the same reason every other
 * provider does it: a setting that only means something to one upstream does not belong in a file
 * every upstream reads.
 */

import { ccDataPath, resolveStatePath } from '../data-path';
import { createStateFileWriter } from '@/core/state-file';
import { DEFAULT_JITTER_CONFIG, type JitterConfig } from '@/core/jitter';

const CONFIG_FILE = process.env.CLAUDE_CODE_CONFIG_FILE || ccDataPath('config.json');

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
  /**
   * The `anthropic-beta` gates every request asks for.
   *
   * Empty means "use `DEFAULT_BETA_FEATURES`", not "send none" — an empty list here is what a config
   * file written before this field existed looks like, and reading that as "disable every capability"
   * would silently downgrade an upgraded gateway. To genuinely send none, set a list with one empty
   * string, which is filtered out.
   *
   * Replaces the default wholesale rather than merging, because the reason to touch this is usually a
   * gate that has graduated and is now *rejected* as unknown — a merge could not remove one.
   */
  betaFeatures: string[];
  /**
   * Whether client tool names are suffixed on the way up. See `mappers/tool-names.ts`.
   *
   * On by default because the collision it avoids is silent: an unsuffixed client tool sharing a name
   * with one the upstream already knows produces a call the client cannot execute, with no error to
   * point at. Off is for diagnosing whether a tool problem is this mechanic's fault.
   */
  cloakToolNames: boolean;
  /**
   * The suffix itself. Configurable because it has to not collide with a real client tool name, and
   * only the operator knows what their clients declare.
   */
  toolNameSuffix: string;
}

const DEFAULTS: ClaudeCodeConfig = {
  baseUrl: 'https://api.anthropic.com',
  features: DEFAULT_JITTER_CONFIG,
  refreshCommand: '',
  betaFeatures: [],
  cloakToolNames: true,
  toolNameSuffix: '_ide',
};

let current: ClaudeCodeConfig = { ...DEFAULTS };

export async function loadClaudeCodeConfig(): Promise<void> {
  try {
    // Reads may still come from the pre-rename directory; writes always go to CONFIG_FILE.
    const path = process.env.CLAUDE_CODE_CONFIG_FILE ?? (await resolveStatePath('config.json'));
    if (path) {
      current = { ...DEFAULTS, ...(await Bun.file(path).json()) };
    }
  } catch (error) {
    console.error('[cc] could not read config, using defaults:', error);
    current = { ...DEFAULTS };
  }
}

export function getClaudeCodeConfig(): ClaudeCodeConfig {
  return current;
}

const writer = createStateFileWriter<ClaudeCodeConfig>(CONFIG_FILE, {
  label: 'cc config',
});

export async function updateClaudeCodeConfig(patch: Partial<ClaudeCodeConfig>): Promise<ClaudeCodeConfig> {
  current = { ...current, ...patch };
  writer.schedule(current);
  writer.flush();
  return current;
}
