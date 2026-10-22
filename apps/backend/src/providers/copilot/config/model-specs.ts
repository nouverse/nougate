import type { IModelRegistry, IModelSpec } from '@/core/interfaces';
import { getProxyConfig } from '@/config/manager';
import { dataPath } from '@/core/paths';

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
  'gpt-4.1': {
    modelId: 'gpt-4.1',
    displayName: 'GPT-4.1',
    pool: 'cli',
    isThinking: false,
    maxOutputTokens: 8192,
    upstreamModelId: 'gpt-4.1',
    timeoutMs: 60000,
  },
  'gpt-5.6-luna': {
    modelId: 'gpt-5.6-luna',
    displayName: 'GPT-5.6 Luna',
    pool: 'cli',
    isThinking: false,
    maxOutputTokens: 8192,
    upstreamModelId: 'gpt-5.6-luna',
    timeoutMs: 60000,
  },
  'gpt-5.6-terra': {
    modelId: 'gpt-5.6-terra',
    displayName: 'GPT-5.6 Terra',
    pool: 'cli',
    isThinking: false,
    maxOutputTokens: 8192,
    upstreamModelId: 'gpt-5.6-terra',
    timeoutMs: 60000,
  },
  'gpt-5.6-sol': {
    modelId: 'gpt-5.6-sol',
    displayName: 'GPT-5.6 Sol',
    pool: 'cli',
    isThinking: false,
    maxOutputTokens: 8192,
    upstreamModelId: 'gpt-5.6-sol',
    timeoutMs: 60000,
  },
  'gpt-6-luna': {
    modelId: 'gpt-6-luna',
    displayName: 'GPT-6 Luna',
    pool: 'cli',
    isThinking: false,
    maxOutputTokens: 8192,
    upstreamModelId: 'gpt-6-luna',
    timeoutMs: 60000,
  },
  'gpt-6-terra': {
    modelId: 'gpt-6-terra',
    displayName: 'GPT-6 Terra',
    pool: 'cli',
    isThinking: false,
    maxOutputTokens: 8192,
    upstreamModelId: 'gpt-6-terra',
    timeoutMs: 60000,
  },
  'gpt-6-sol': {
    modelId: 'gpt-6-sol',
    displayName: 'GPT-6 Sol',
    pool: 'cli',
    isThinking: false,
    maxOutputTokens: 8192,
    upstreamModelId: 'gpt-6-sol',
    timeoutMs: 60000,
  },
  'gpt-6-astra': {
    modelId: 'gpt-6-astra',
    displayName: 'GPT-6 Astra',
    pool: 'cli',
    isThinking: false,
    maxOutputTokens: 8192,
    upstreamModelId: 'gpt-6-astra',
    timeoutMs: 60000,
  },
  'claude-haiku-5.5': {
    modelId: 'claude-haiku-5.5',
    displayName: 'Claude Haiku 5.5',
    pool: 'cli',
    isThinking: false,
    maxOutputTokens: 8192,
    upstreamModelId: 'claude-haiku-5.5',
    timeoutMs: 60000,
  },
  'claude-haiku-4.5': {
    modelId: 'claude-haiku-4.5',
    displayName: 'Claude Haiku 4.5',
    pool: 'cli',
    isThinking: false,
    maxOutputTokens: 8192,
    upstreamModelId: 'claude-haiku-4.5',
    timeoutMs: 60000,
  },
  'claude-sonnet-5.5': {
    modelId: 'claude-sonnet-5.5',
    displayName: 'Claude Sonnet 5.5',
    pool: 'cli',
    isThinking: false,
    maxOutputTokens: 8192,
    upstreamModelId: 'claude-sonnet-5.5',
    timeoutMs: 60000,
  },
  'claude-sonnet-5': {
    modelId: 'claude-sonnet-5',
    displayName: 'Claude Sonnet 5',
    pool: 'cli',
    isThinking: false,
    maxOutputTokens: 8192,
    upstreamModelId: 'claude-sonnet-5',
    timeoutMs: 60000,
  },
  'claude-opus-5': {
    modelId: 'claude-opus-5',
    displayName: 'Claude Opus 5',
    pool: 'cli',
    isThinking: false,
    maxOutputTokens: 8192,
    upstreamModelId: 'claude-opus-4.5',
    timeoutMs: 60000,
  },
  'claude-opus-5.5': {
    modelId: 'claude-opus-5.5',
    displayName: 'Claude Opus 5.5',
    pool: 'cli',
    isThinking: false,
    maxOutputTokens: 8192,
    upstreamModelId: 'claude-opus-5.5',
    timeoutMs: 60000,
  },
  'claude-fable-5': {
    modelId: 'claude-fable-5',
    displayName: 'Claude Fable 5',
    pool: 'cli',
    isThinking: false,
    maxOutputTokens: 8192,
    upstreamModelId: 'claude-fable-5',
    timeoutMs: 60000,
  },
  'claude-fable-5.1': {
    modelId: 'claude-fable-5.1',
    displayName: 'Claude Fable 5.1',
    pool: 'cli',
    isThinking: false,
    maxOutputTokens: 8192,
    upstreamModelId: 'claude-fable-5.1',
    timeoutMs: 60000,
  },
  'gemini-3.8-flash': {
    modelId: 'gemini-3.8-flash',
    displayName: 'Gemini 3.8 Flash',
    pool: 'cli',
    isThinking: false,
    maxOutputTokens: 8192,
    upstreamModelId: 'gemini-3.8-flash',
    timeoutMs: 60000,
  },
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
  const paths = [dataPath('providers', 'copilot', 'model-specs.json')];

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
