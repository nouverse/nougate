import { existsSync } from 'fs';
import { mkdir } from 'fs/promises';
import { dirname, join } from 'path';

export interface AntigravityQuotaConfig {
  refreshIntervalMs: number;
  initialDelayMs: number;
}

export interface AntigravityEndpointsConfig {
  sandbox: string[];
  cli: string[];
}

export interface AntigravityFeaturesConfig {
  googleSearchGrounding: boolean;
  groundingMode: 'auto' | 'always';
  keepThinking: boolean;
  sanitizeToolNames: boolean;
  pidOffsetEnabled: boolean;
  softQuotaThresholdPercent: number;
  jitterEnabled: boolean;
  jitterMinMs: number;
  jitterMaxMs: number;
}

export interface AntigravitySchedulingConfig {
  mode: 'cache_first' | 'balance' | 'performance_first';
  maxCacheFirstWaitSeconds: number;
  maxRateLimitWaitSeconds: number;
}

export interface AntigravityModelsConfig {
  blacklist: string[];
}

export interface AntigravityConfig {
  quota: AntigravityQuotaConfig;
  endpoints: AntigravityEndpointsConfig;
  features: AntigravityFeaturesConfig;
  scheduling: AntigravitySchedulingConfig;
  models: AntigravityModelsConfig;
}

const DEFAULT_ANTIGRAVITY_CONFIG: AntigravityConfig = {
  quota: {
    refreshIntervalMs: 300000,
    initialDelayMs: 10000,
  },
  endpoints: {
    sandbox: [
      'https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse',
      'https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse',
      'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse',
    ],
    cli: [
      'https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse',
      'https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse',
    ],
  },
  features: {
    googleSearchGrounding: false,
    groundingMode: 'auto',
    keepThinking: false,
    sanitizeToolNames: true,
    pidOffsetEnabled: false,
    softQuotaThresholdPercent: 90,
    jitterEnabled: true,
    jitterMinMs: 2000,
    jitterMaxMs: 5000,
  },
  scheduling: {
    mode: 'cache_first',
    maxCacheFirstWaitSeconds: 60,
    maxRateLimitWaitSeconds: 300,
  },
  models: {
    blacklist: [],
  },
};

const DEFAULT_CONFIG_PATH = existsSync('/app/data')
  ? '/app/data/providers/antigravity/config.json'
  : join(process.cwd(), 'providers', 'antigravity', 'config.json');

const LEGACY_PROXY_CONFIG_PATH = existsSync('/app/data')
  ? '/app/data/config.json'
  : join(process.cwd(), 'config.json');

const CONFIG_PATH = process.env.ANTIGRAVITY_CONFIG_FILE || DEFAULT_CONFIG_PATH;

let antigravityConfig: AntigravityConfig | undefined;

/**
 * Ensure the config directory exists before writing provider-local config.
 */
async function ensureConfigDirectory(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

/**
 * Merge only keys that already exist in the target config shape.
 */
function mergeKnownKeys(target: any, source: any): any {
  const result = Array.isArray(target) ? [...target] : { ...target };

  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return result;
  }

  for (const key of Object.keys(target)) {
    if (!(key in source)) {
      continue;
    }

    const sourceValue = source[key];
    const targetValue = target[key];

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

/**
 * Pull provider-owned config fields out of the legacy global config shape.
 */
function extractLegacyProviderConfig(source: any): Partial<AntigravityConfig> {
  return {
    quota: source?.quota,
    endpoints: source?.endpoints,
    features: source?.features,
    scheduling: source?.scheduling,
    models: {
      blacklist: source?.models?.blacklist,
    },
  };
}

/**
 * Load provider config from the new location with legacy fallback support.
 */
export async function loadAntigravityConfig(): Promise<AntigravityConfig> {
  const candidatePaths = [CONFIG_PATH, LEGACY_PROXY_CONFIG_PATH].filter(
    (path, index, list) => list.indexOf(path) === index,
  );

  for (const path of candidatePaths) {
    try {
      const file = Bun.file(path);
      if (!(await file.exists())) {
        continue;
      }

      const loadedConfig = JSON.parse(await file.text());
      const sourceConfig =
        path === LEGACY_PROXY_CONFIG_PATH
          ? extractLegacyProviderConfig(loadedConfig)
          : loadedConfig;

      antigravityConfig = mergeKnownKeys(
        DEFAULT_ANTIGRAVITY_CONFIG,
        sourceConfig,
      ) as AntigravityConfig;

      if (path === LEGACY_PROXY_CONFIG_PATH && CONFIG_PATH !== LEGACY_PROXY_CONFIG_PATH) {
        await saveAntigravityConfig(antigravityConfig);
      }

      return antigravityConfig;
    } catch (error) {
      console.error('[AntigravityConfig] Failed to load config:', error);
    }
  }

  antigravityConfig = DEFAULT_ANTIGRAVITY_CONFIG;
  await saveAntigravityConfig(antigravityConfig);
  return antigravityConfig;
}

/**
 * Persist the provider-local config to disk.
 */
export async function saveAntigravityConfig(newConfig: AntigravityConfig): Promise<void> {
  const normalizedConfig = mergeKnownKeys(
    DEFAULT_ANTIGRAVITY_CONFIG,
    newConfig,
  ) as AntigravityConfig;

  await ensureConfigDirectory(CONFIG_PATH);
  await Bun.write(CONFIG_PATH, JSON.stringify(normalizedConfig, null, 2));
  antigravityConfig = normalizedConfig;
}

/**
 * Return the loaded provider config.
 */
export function getAntigravityConfig(): AntigravityConfig {
  if (!antigravityConfig) {
    throw new Error(
      '[AntigravityConfig] Configuration not initialized. Call loadAntigravityConfig() first.',
    );
  }

  return antigravityConfig;
}

/**
 * Apply a partial provider config update and persist the merged result.
 */
export async function updateAntigravityConfig(
  updates: Partial<AntigravityConfig>,
): Promise<AntigravityConfig> {
  const mergedConfig = mergeKnownKeys(
    getAntigravityConfig(),
    updates,
  ) as AntigravityConfig;

  await saveAntigravityConfig(mergedConfig);
  return mergedConfig;
}
