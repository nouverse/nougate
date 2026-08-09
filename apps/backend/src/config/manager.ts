import { type ProxyConfig } from '@/config/types';
import { EventEmitter } from 'node:events';
import { join } from 'path';
import { existsSync } from 'fs';
import { getProjectRoot } from '@/core/paths';
import { writeJsonAtomic } from '@/core/state-file';

/**
 * Resolve config.json without consulting `process.cwd()`.
 *
 * Launching from the repo root and launching from `apps/backend` used to read
 * two different files, so a setting saved under one would silently not apply
 * under the other. An existing file is always preferred so no one's settings
 * move when they upgrade.
 */
function resolveConfigPath(): string {
  if (process.env.CONFIG_FILE) {
    return process.env.CONFIG_FILE;
  }

  if (existsSync('/app/data')) {
    return '/app/data/config.json';
  }

  const root = getProjectRoot();
  const candidates = [join(root, 'config.json'), join(root, 'data', 'config.json')];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

const CONFIG_PATH = resolveConfigPath();

/**
 * Warn about a config file an earlier build may have written next to the
 * backend package, which is no longer read.
 */
function warnAboutStrayConfig(): void {
  const stray = join(getProjectRoot(), 'apps', 'backend', 'config.json');
  if (stray !== CONFIG_PATH && existsSync(stray)) {
    console.warn(
      `[Config] Ignoring stray config at ${stray} — the active file is ${CONFIG_PATH}. ` +
        'Delete the stray file to avoid confusion.',
    );
  }
}
export const configEventBus = new EventEmitter();

let config: ProxyConfig;

const DEFAULT_CONFIG: ProxyConfig = {
  baseUrl: 'http://localhost:3000',
  bypassModelValidation: false,
  rotation: {
    strategy: 'hybrid',
    cooldown: {
      defaultDurationMs: 60000,
      maxDurationMs: 3600000
    }
  },
  scoring: {
    healthRange: {
      min: 0,
      max: 100,
      initial: 100
    },
    penalties: {
      apiError: -10,
      refreshError: -20,
      fatalError: -50,
      systemicError: -5
    },
    rewards: {
      success: 1
    },
    weights: {
      health: 2.0,
      lru: 0.1
    }
  },
  retry: {
    maxAttempts: 5,
    transientRetryThresholdSeconds: 5
  },
  tokens: {
    expiryBufferMs: 60000
  },
  logging: {
    maxBufferSize: 200,
    enableConsoleCapture: true
  },
  headroom: {
    enabled: false,
    url: process.env.HEADROOM_URL || undefined,
    timeoutMs: 5000
  },
  caveman: {
    enabled: false,
    level: 3
  },
  rtk: {
    enabled: true
  },
  debugLogger: {
    enabled: false,
    outputDir: './tmp/debug-payloads'
  },
  metrics: {
    enabled: true,
    detailRetentionDays: 14,
    rollupRetentionDays: 90,
    defaultInputPricePer1M: Number(process.env.DEFAULT_INPUT_PRICE_1M ?? 0),
    defaultOutputPricePer1M: Number(process.env.DEFAULT_OUTPUT_PRICE_1M ?? 0)
  },
  apiKeys: {
    enabled: false
  }
};

export async function loadProxyConfig(): Promise<ProxyConfig> {
  try {
    const file = Bun.file(CONFIG_PATH);
    const exists = await file.exists();

    if (!exists) {
      console.log('[Config] config.json not found, creating with defaults...');
      await saveProxyConfig(DEFAULT_CONFIG);
      config = { ...DEFAULT_CONFIG };
    } else {
      const text = await file.text();
      const loadedConfig = JSON.parse(text);
      config = mergeKnownKeys(DEFAULT_CONFIG, loadedConfig) as ProxyConfig;
    }
  } catch (e) {
    console.error('[Config] Failed to load config.json, using defaults:', e);
    config = { ...DEFAULT_CONFIG };
  }

  if (process.env.BASE_URL) {
    config.baseUrl = process.env.BASE_URL;
  }

  // Always use HEADROOM_URL from env if available (docker-first approach)
  if (process.env.HEADROOM_URL && config.headroom) {
    config.headroom.url = process.env.HEADROOM_URL;
  }

  warnAboutStrayConfig();
  console.log(
    `[Config] Loaded configuration from ${CONFIG_PATH}: strategy=${config.rotation.strategy}`,
  );
  return config;
}

export async function saveProxyConfig(newConfig: ProxyConfig): Promise<void> {
  try {
    writeJsonAtomic(CONFIG_PATH, newConfig);
    config = newConfig;
    configEventBus.emit('update', config);
    console.log('[Config] Configuration saved successfully');
  } catch (e) {
    console.error('[Config] Failed to save config.json:', e);
    throw e;
  }
}

export function getProxyConfig(): ProxyConfig {
  if (!config) {
    throw new Error('[Config] Configuration not initialized. Call loadProxyConfig() first.');
  }
  return config;
}

export async function updateProxyConfig(updates: Partial<ProxyConfig>): Promise<ProxyConfig> {
  const merged = mergeKnownKeys(config, updates);
  await saveProxyConfig(merged);
  return merged;
}

/**
 * Merge only keys that are already part of the target shape.
 */
function mergeKnownKeys(target: any, source: any): any {
  const result = { ...target };

  if (!source || typeof source !== 'object') {
    return result;
  }

  for (const key of Object.keys(target)) {
    if (!(key in source)) {
      continue;
    }

    const sourceValue = source[key];
    const targetValue = target[key];

    if (sourceValue === undefined) {
      continue;
    }

    if (
      sourceValue !== null &&
      typeof sourceValue === 'object' &&
      !Array.isArray(sourceValue) &&
      targetValue !== null &&
      typeof targetValue === 'object' &&
      !Array.isArray(targetValue)
    ) {
      result[key] = mergeKnownKeys(targetValue, sourceValue);
      continue;
    }

    result[key] = sourceValue;
  }

  return result;
}
