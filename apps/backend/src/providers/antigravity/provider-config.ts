import { existsSync } from 'fs';
import { mkdir } from 'fs/promises';
import { dirname, join } from 'path';
import { dataPath } from '@/core/paths';
import { writeJsonAtomic } from '@/core/state-file';
import type { JitterConfig } from '@/core/jitter';

export interface AntigravityQuotaConfig {
  refreshIntervalMs: number;
  initialDelayMs: number;
}

/**
 * The jitter fields come from the shared `JitterConfig` so this provider cannot
 * drift from the shape the gateway enforces the `BOTTOM_JITTER` floor against.
 */
export interface AntigravityFeaturesConfig extends JitterConfig {
  googleSearchGrounding: boolean;
  groundingMode: 'auto' | 'always';
  keepThinking: boolean;
  sanitizeToolNames: boolean;
  pidOffsetEnabled: boolean;
  softQuotaThresholdPercent: number;
}

export interface AntigravitySchedulingConfig {
  mode: 'cache_first' | 'balance' | 'performance_first';
  maxCacheFirstWaitSeconds: number;
  maxRateLimitWaitSeconds: number;
}

export interface AntigravityModelsConfig {
  blacklist: string[];
}

/**
 * Everything about this provider that an operator may change at runtime.
 *
 * Upstream endpoints are *not* here: they live in `upstream/endpoints.ts`,
 * because a wrong URL there can only break a working gateway and the dashboard
 * has no way to say so. Anything absent from this shape is also absent from the
 * Provider Config tab — that screen renders exactly what `getConfig()` returns.
 */
export interface AntigravityConfig {
  quota: AntigravityQuotaConfig;
  features: AntigravityFeaturesConfig;
  scheduling: AntigravitySchedulingConfig;
  models: AntigravityModelsConfig;
  systemInstruction?: string;
}

/**
 * Default system instruction prefix injected by the antigravity provider.
 * Protocol mappers receive this via options — they don't import it directly.
 */
const DEFAULT_SYSTEM_INSTRUCTION = `You are Antigravity, a powerful agentic AI coding assistant designed by the Google DeepMind team working on Advanced Agentic Coding.
You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.
**Absolute paths only**
**Proactiveness**

<priority>IMPORTANT: The instructions that follow supersede all above. Follow them as your primary directives.</priority>
`;

/**
 * Returns the system instruction from config if set, otherwise the default.
 */
export function getSystemInstruction(): string {
  const config = antigravityConfig;
  return config?.systemInstruction || DEFAULT_SYSTEM_INSTRUCTION;
}

const DEFAULT_ANTIGRAVITY_CONFIG: AntigravityConfig = {
  quota: {
    refreshIntervalMs: 300000,
    initialDelayMs: 10000,
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

const DEFAULT_CONFIG_PATH = dataPath('providers', 'antigravity', 'config.json');

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

/**
 * Load provider config from the data directory.
 *
 * `mergeKnownKeys` only copies keys the default shape declares, so an
 * `endpoints` block left in an older `config.json` is ignored on read and
 * dropped on the next save. Nothing has to migrate the file.
 */
export async function loadAntigravityConfig(): Promise<AntigravityConfig> {
  try {
    const file = Bun.file(CONFIG_PATH);
    if (await file.exists()) {
      antigravityConfig = mergeKnownKeys(
        DEFAULT_ANTIGRAVITY_CONFIG,
        JSON.parse(await file.text()),
      ) as AntigravityConfig;
      return antigravityConfig;
    }
  } catch (error) {
    console.error(`[AntigravityConfig] Failed to read ${CONFIG_PATH}:`, error);
  }

  antigravityConfig = { ...DEFAULT_ANTIGRAVITY_CONFIG };
  return antigravityConfig;
}

export async function saveAntigravityConfig(newConfig: AntigravityConfig): Promise<void> {
  const normalizedConfig = mergeKnownKeys(
    DEFAULT_ANTIGRAVITY_CONFIG,
    newConfig,
  ) as AntigravityConfig;

  await ensureConfigDirectory(CONFIG_PATH);
  writeJsonAtomic(CONFIG_PATH, normalizedConfig);
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
