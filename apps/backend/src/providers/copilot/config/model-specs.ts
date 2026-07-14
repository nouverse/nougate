import { existsSync } from 'fs';
import { join } from 'path';
import type { IModelRegistry, IModelSpec } from '@/core/interfaces';
import { getProxyConfig } from '@/config/manager';

const MODEL_REGISTRY: Record<string, IModelSpec> = {
  'gpt-4o': {
    modelId: 'gpt-4o',
    displayName: 'GPT-4o',
    pool: 'cli',
    isThinking: false,
    maxOutputTokens: 4096,
    upstreamModelId: 'gpt-4o',
    timeoutMs: 60000,
  },
  'claude-3.5-sonnet': {
    modelId: 'claude-3.5-sonnet',
    displayName: 'Claude 3.5 Sonnet',
    pool: 'cli',
    isThinking: false,
    maxOutputTokens: 8192,
    upstreamModelId: 'claude-3.5-sonnet',
    timeoutMs: 60000,
  },
  'gemini-1.5-pro': {
    modelId: 'gemini-1.5-pro',
    displayName: 'Gemini 1.5 Pro',
    pool: 'cli',
    isThinking: false,
    maxOutputTokens: 8192,
    upstreamModelId: 'gemini-1.5-pro',
    timeoutMs: 60000,
  },
  'o3-mini': {
    modelId: 'o3-mini',
    displayName: 'o3-mini',
    pool: 'cli',
    isThinking: true,
    maxOutputTokens: 8192,
    upstreamModelId: 'o3-mini',
    timeoutMs: 60000,
  }
};

function cloneModelSpec(modelSpec: IModelSpec): IModelSpec {
  return {
    ...modelSpec,
  };
}

function createDefaultModelSpec(modelId: string, override: Partial<IModelSpec>): IModelSpec {
  return {
    modelId,
    pool: override.pool ?? 'cli',
    isThinking: override.isThinking ?? false,
    maxOutputTokens: override.maxOutputTokens ?? 4096,
    timeoutMs: override.timeoutMs ?? 60000,
    ...override,
  };
}

function normalizeModelId(modelId: string): string {
  return modelId.trim().toLowerCase();
}

export async function loadModelSpecOverrides(): Promise<void> {
  const paths = [
    existsSync('/app/data') ? '/app/data/providers/copilot/model-specs.json' : null,
    join(process.cwd(), 'providers', 'copilot', 'model-specs.json'),
  ].filter(Boolean) as string[];

  for (const path of paths) {
    try {
      const file = Bun.file(path);
      if (!(await file.exists())) {
        continue;
      }

      const overrides = await file.json() as Record<string, Partial<IModelSpec>>;
      for (const [rawModelId, override] of Object.entries(overrides)) {
        const modelId = normalizeModelId(rawModelId);
        const current = MODEL_REGISTRY[modelId];
        MODEL_REGISTRY[modelId] = current
          ? { ...current, ...override, modelId }
          : createDefaultModelSpec(modelId, override);
      }

      console.log(`[CopilotModelRegistry] Loaded overrides from ${path}`);
      return;
    } catch (error) {
      console.warn(`[CopilotModelRegistry] Failed to load overrides from ${path}:`, error);
    }
  }
}

export function getModelSpec(modelId: string): IModelSpec | null {
  const normalized = normalizeModelId(modelId);
  const modelSpec = MODEL_REGISTRY[normalized];
  if (modelSpec) {
    return cloneModelSpec(modelSpec);
  }

  try {
    const proxyConfig = getProxyConfig();
    if (proxyConfig && proxyConfig.bypassModelValidation) {
      console.log(`[CopilotModelRegistry] Unknown model "${modelId}" requested, generating dynamic spec fallback.`);
      return createDefaultModelSpec(modelId, {
        isThinking: modelId.toLowerCase().includes("thinking") || modelId.toLowerCase().includes("o3"),
        maxOutputTokens: 8192,
      });
    }
  } catch (error) {
    // Standard fallback behavior if config manager isn't initialized/ready
  }

  return null;
}

export const copilotModelRegistry: IModelRegistry = {
  getSpec(modelId: string): IModelSpec | null {
    return getModelSpec(modelId);
  },
  listModelIds(): string[] {
    return Object.keys(MODEL_REGISTRY).sort();
  },
};
