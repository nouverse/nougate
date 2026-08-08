import { existsSync } from 'fs';
import { mkdir } from 'fs/promises';
import { dirname, join } from 'path';
import { resolveStateFile } from '@/core/paths';

export interface CopilotFeaturesConfig {
  jitterEnabled: boolean;
  jitterMinMs: number;
  jitterMaxMs: number;
}

export interface CopilotConfig {
  features: CopilotFeaturesConfig;
}

const DEFAULT_COPILOT_CONFIG: CopilotConfig = {
  features: {
    jitterEnabled: true,
    jitterMinMs: 1000,
    jitterMaxMs: 3000,
  },
};

const DEFAULT_CONFIG_PATH = resolveStateFile('providers', 'copilot', 'config.json');

const CONFIG_PATH = process.env.COPILOT_CONFIG_FILE || DEFAULT_CONFIG_PATH;

let copilotConfig: CopilotConfig | undefined;

async function ensureConfigDirectory(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

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

export async function loadCopilotConfig(): Promise<CopilotConfig> {
  try {
    const file = Bun.file(CONFIG_PATH);
    if (await file.exists()) {
      const loadedConfig = JSON.parse(await file.text());
      copilotConfig = mergeKnownKeys(
        DEFAULT_COPILOT_CONFIG,
        loadedConfig,
      ) as CopilotConfig;
      return copilotConfig;
    }
  } catch (error) {
    console.error('[CopilotConfig] Failed to load config:', error);
  }

  copilotConfig = DEFAULT_COPILOT_CONFIG;
  await saveCopilotConfig(copilotConfig);
  return copilotConfig;
}

export async function saveCopilotConfig(newConfig: CopilotConfig): Promise<void> {
  const normalizedConfig = mergeKnownKeys(
    DEFAULT_COPILOT_CONFIG,
    newConfig,
  ) as CopilotConfig;

  await ensureConfigDirectory(CONFIG_PATH);
  await Bun.write(CONFIG_PATH, JSON.stringify(normalizedConfig, null, 2));
  copilotConfig = normalizedConfig;
}

export function getCopilotConfig(): CopilotConfig {
  if (!copilotConfig) {
    throw new Error(
      '[CopilotConfig] Configuration not initialized. Call loadCopilotConfig() first.',
    );
  }

  return copilotConfig;
}

export async function updateCopilotConfig(
  updates: Partial<CopilotConfig>,
): Promise<CopilotConfig> {
  const mergedConfig = mergeKnownKeys(
    getCopilotConfig(),
    updates,
  ) as CopilotConfig;

  await saveCopilotConfig(mergedConfig);
  return mergedConfig;
}
