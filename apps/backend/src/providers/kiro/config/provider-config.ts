/**
 * Kiro provider-level settings — what an operator may change from the Provider Config tab.
 *
 * Only values whose wrong entry is recoverable from that same screen live here. Upstream URLs,
 * header sets and wire constants are code (`upstream/endpoints.ts`, `upstream/headers.ts`): a typo
 * in any of those takes the provider down, and a JSON editor has no way to say so.
 */

import { dataPath } from '@/core/paths';
import { createStateFileWriter } from '@/core/state-file';
import { DEFAULT_JITTER_CONFIG, type JitterConfig } from '@/core/jitter';

const CONFIG_FILE = process.env.KIRO_CONFIG_FILE || dataPath('providers', 'kiro', 'config.json');

export interface KiroFeaturesConfig extends JitterConfig {
  /**
   * Fetch `ListAvailableModels` on start, after an account is added and every six hours, and offer
   * models the static catalogue does not list.
   */
  liveModelCatalog: boolean;
  /**
   * Freeze the first user turn of a conversation so later turns replay it byte-identically and hit
   * Kiro's prompt cache. See `session-replay.ts`.
   */
  sessionReplay: boolean;
}

export interface KiroConfig {
  features: KiroFeaturesConfig;
  /**
   * The Kiro IDE version claimed in the `ListAvailableModels` User-Agent.
   *
   * Configurable for the same reason Codex's `cliVersion` is: an upstream that gates on client
   * version goes stale on its schedule, not this gateway's.
   */
  ideVersion: string;
  /**
   * Largest tool-call input held while it is still arriving, in bytes. A tool call is the one thing
   * that must be complete before it is sent, so each is buffered until its last fragment — this is
   * the ceiling on that, not on the response.
   */
  maxToolInputBytes: number;
}

const DEFAULTS: KiroConfig = {
  features: {
    ...DEFAULT_JITTER_CONFIG,
    liveModelCatalog: true,
    sessionReplay: true,
  },
  ideVersion: '0.10.32',
  maxToolInputBytes: 4 * 1024 * 1024,
};

let current: KiroConfig = structuredClone(DEFAULTS);

function merge(base: KiroConfig, patch: Partial<KiroConfig> | undefined): KiroConfig {
  return {
    ...base,
    ...(patch || {}),
    features: { ...base.features, ...(patch?.features || {}) },
  };
}

export async function loadKiroConfig(): Promise<void> {
  try {
    const file = Bun.file(CONFIG_FILE);
    current = (await file.exists()) ? merge(DEFAULTS, await file.json()) : structuredClone(DEFAULTS);
  } catch (error) {
    console.error('[kiro] could not read config, using defaults:', error);
    current = structuredClone(DEFAULTS);
  }
}

export function getKiroConfig(): KiroConfig {
  return current;
}

const writer = createStateFileWriter<KiroConfig>(CONFIG_FILE, { label: 'kiro config' });

export async function updateKiroConfig(patch: Partial<KiroConfig>): Promise<KiroConfig> {
  current = merge(current, patch);
  writer.schedule(current);
  writer.flush();
  return current;
}
