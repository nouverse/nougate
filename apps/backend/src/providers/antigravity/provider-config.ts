import { existsSync } from 'fs';
import { mkdir } from 'fs/promises';
import { dirname, join } from 'path';
import { dataPath } from '@/core/paths';
import { writeJsonAtomic } from '@/core/state-file';

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
 * Load provider config from the data directory.
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
