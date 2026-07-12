import { existsSync } from 'fs';
import { join } from 'path';
import type { IModelRegistry, IModelSpec } from '../../../core/interfaces';

const DEFAULT_THINKING_BUDGET = 16000;
const DEFAULT_THINKING_LEVEL = 'low';
const THINKING_BUDGET_DEFAULTS = {
  low: 8192,
  medium: 16000,
  high: 32768,
  default: DEFAULT_THINKING_BUDGET,
} as const;

const SANDBOX_TIER_DEFAULTS: Record<string, string> = {
  'gemini-3.5-flash': 'high',
  'gemini-3.1-pro': 'high',
  'gemini-3-pro': 'high',
};

const SANDBOX_PASSTHROUGH_MODELS = [
  'gemini-3-flash',
  'gpt-oss',
] as const;

const LEGACY_GPT_FALLBACKS = {
  thinking: 'gpt-oss-120b-medium',
  default: 'gpt-oss-120b',
} as const;

const MODEL_REGISTRY: Record<string, IModelSpec> = {
  'gemini-3.5-flash-low': {
    modelId: 'gemini-3.5-flash-low',
    pool: 'sandbox',
    isThinking: true,
    thinkingMode: 'level',
    thinkingLevel: 'low',
    maxOutputTokens: 64000,
    timeoutMs: 60000,
  },
  'gemini-3.5-flash-high': {
    modelId: 'gemini-3.5-flash-high',
    pool: 'sandbox',
    isThinking: true,
    thinkingMode: 'level',
    thinkingLevel: 'high',
    maxOutputTokens: 64000,
    timeoutMs: 60000,
  },
  'gemini-3.1-pro-low': {
    modelId: 'gemini-3.1-pro-low',
    pool: 'sandbox',
    isThinking: true,
    thinkingMode: 'level',
    thinkingLevel: 'low',
    maxOutputTokens: 64000,
    timeoutMs: 45000,
  },
  'gemini-3.1-pro': {
    modelId: 'gemini-3.1-pro',
    pool: 'sandbox',
    isThinking: true,
    thinkingMode: 'level',
    thinkingLevel: 'low',
    maxOutputTokens: 64000,
    timeoutMs: 45000,
  },
  'gemini-3.1-pro-high': {
    modelId: 'gemini-3.1-pro-high',
    pool: 'sandbox',
    isThinking: true,
    thinkingMode: 'level',
    thinkingLevel: 'high',
    maxOutputTokens: 64000,
    timeoutMs: 45000,
  },
  'gemini-3.1-pro-preview': {
    modelId: 'gemini-3.1-pro-preview',
    pool: 'cli',
    isThinking: true,
    thinkingMode: 'level',
    thinkingLevel: 'low',
    maxOutputTokens: 64000,
    timeoutMs: 45000,
  },
  'gemini-3-pro-low': {
    modelId: 'gemini-3-pro-low',
    pool: 'sandbox',
    isThinking: true,
    thinkingMode: 'level',
    thinkingLevel: 'low',
    maxOutputTokens: 64000,
    timeoutMs: 45000,
  },
  'gemini-3-pro': {
    modelId: 'gemini-3-pro',
    pool: 'sandbox',
    isThinking: true,
    thinkingMode: 'level',
    thinkingLevel: 'low',
    maxOutputTokens: 64000,
    timeoutMs: 45000,
  },
  'gemini-3-pro-high': {
    modelId: 'gemini-3-pro-high',
    pool: 'sandbox',
    isThinking: true,
    thinkingMode: 'level',
    thinkingLevel: 'high',
    maxOutputTokens: 64000,
    timeoutMs: 45000,
  },
  'gemini-3-pro-preview': {
    modelId: 'gemini-3-pro-preview',
    pool: 'cli',
    isThinking: true,
    thinkingMode: 'level',
    thinkingLevel: 'low',
    maxOutputTokens: 64000,
    timeoutMs: 45000,
  },
  'gemini-3-flash': {
    modelId: 'gemini-3-flash',
    pool: 'cli',
    isThinking: false,
    maxOutputTokens: 8192,
    timeoutMs: 60000,
  },
  'gemini-3-flash-preview': {
    modelId: 'gemini-3-flash-preview',
    pool: 'cli',
    isThinking: false,
    maxOutputTokens: 8192,
    timeoutMs: 60000,
  },
  'gemini-2.5-pro': {
    modelId: 'gemini-2.5-pro',
    pool: 'sandbox',
    isThinking: false,
    maxOutputTokens: 4096,
    timeoutMs: 60000,
  },
  'gemini-2.5-flash': {
    modelId: 'gemini-2.5-flash',
    pool: 'sandbox',
    isThinking: false,
    maxOutputTokens: 4096,
    timeoutMs: 60000,
  },
  'gemini-2.5-flash-lite': {
    modelId: 'gemini-2.5-flash-lite',
    pool: 'sandbox',
    isThinking: false,
    maxOutputTokens: 4096,
    timeoutMs: 60000,
  },
  'gemini-2.5-flash-thinking': {
    modelId: 'gemini-2.5-flash-thinking',
    pool: 'sandbox',
    isThinking: true,
    thinkingMode: 'budget',
    thinkingBudget: 16000,
    maxOutputTokens: 64000,
    timeoutMs: 60000,
  },
  'claude-sonnet-4-5': {
    modelId: 'claude-sonnet-4-5',
    pool: 'sandbox',
    isThinking: false,
    upstreamModelId: 'claude-sonnet-4-5-thinking',
    maxOutputTokens: 8192,
    timeoutMs: 60000,
  },
  'claude-sonnet-4-5-thinking': {
    modelId: 'claude-sonnet-4-5-thinking',
    pool: 'sandbox',
    isThinking: true,
    thinkingMode: 'budget',
    thinkingBudget: 16000,
    maxOutputTokens: 64000,
    timeoutMs: 60000,
  },
  'claude-sonnet-4-6': {
    modelId: 'claude-sonnet-4-6',
    pool: 'sandbox',
    isThinking: false,
    upstreamModelId: 'claude-sonnet-4-6-thinking',
    maxOutputTokens: 8192,
    timeoutMs: 60000,
  },
  'claude-sonnet-4-6-thinking': {
    modelId: 'claude-sonnet-4-6-thinking',
    pool: 'sandbox',
    isThinking: true,
    thinkingMode: 'budget',
    thinkingBudget: 16000,
    maxOutputTokens: 64000,
    timeoutMs: 60000,
  },
  'claude-opus-4-6': {
    modelId: 'claude-opus-4-6',
    pool: 'sandbox',
    isThinking: false,
    upstreamModelId: 'claude-opus-4-6-thinking',
    maxOutputTokens: 8192,
    timeoutMs: 60000,
  },
  'claude-opus-4-6-thinking': {
    modelId: 'claude-opus-4-6-thinking',
    pool: 'sandbox',
    isThinking: true,
    thinkingMode: 'budget',
    thinkingBudget: 32768,
    maxOutputTokens: 64000,
    timeoutMs: 60000,
  },
  'gpt-oss-120b': {
    modelId: 'gpt-oss-120b',
    pool: 'cli',
    isThinking: false,
    maxOutputTokens: 4096,
    timeoutMs: 60000,
  },
  'gpt-oss-120b-medium': {
    modelId: 'gpt-oss-120b-medium',
    pool: 'cli',
    isThinking: false,
    maxOutputTokens: 4096,
    timeoutMs: 60000,
  },
};

/**
 * Clone a model spec so callers do not mutate the in-memory registry accidentally.
 */
function cloneModelSpec(modelSpec: IModelSpec): IModelSpec {
  return {
    ...modelSpec,
  };
}

/**
 * Build a concrete model spec for new override-defined models.
 */
function createDefaultModelSpec(modelId: string, override: Partial<IModelSpec>): IModelSpec {
  return {
    modelId,
    pool: override.pool ?? 'sandbox',
    isThinking: override.isThinking ?? false,
    maxOutputTokens: override.maxOutputTokens ?? 4096,
    timeoutMs: override.timeoutMs ?? 60000,
    ...override,
  };
}

/**
 * Normalize a model identifier before doing registry lookups.
 */
function normalizeModelId(modelId: string): string {
  return modelId.trim().toLowerCase();
}

/**
 * Load optional runtime overrides from providers/antigravity/model-specs.json.
 */
export async function loadModelSpecOverrides(): Promise<void> {
  const paths = [
    existsSync('/app/data') ? '/app/data/providers/antigravity/model-specs.json' : null,
    join(process.cwd(), 'providers', 'antigravity', 'model-specs.json'),
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

      console.log(`[AntigravityModelRegistry] Loaded overrides from ${path}`);
      return;
    } catch (error) {
      console.warn(`[AntigravityModelRegistry] Failed to load overrides from ${path}:`, error);
    }
  }
}

/**
 * Read a model spec with exact provider-local lookup semantics.
 */
export function getModelSpec(modelId: string): IModelSpec | null {
  const normalized = normalizeModelId(modelId);
  const modelSpec = MODEL_REGISTRY[normalized];
  return modelSpec ? cloneModelSpec(modelSpec) : null;
}

/**
 * Transitional compatibility helper for legacy transform logic.
 */
export function resolveClaudeModel(cleanId: string): string | undefined {
  const modelSpec = getModelSpec(cleanId);
  if (!modelSpec || !modelSpec.modelId.includes('claude')) {
    return undefined;
  }

  return modelSpec.modelId;
}

/**
 * Transitional compatibility helper for legacy transform logic.
 */
export function isNativelySupportedModel(googleModel: string, baseModel: string): boolean {
  return getModelSpec(googleModel) !== null || getModelSpec(baseModel) !== null;
}

/**
 * Transitional compatibility helper that maps direct aliases via upstreamModelId only.
 */
export function applyThinkingAlias(modelId: string): string {
  const modelSpec = getModelSpec(modelId);
  return modelSpec?.upstreamModelId ?? modelId;
}

/**
 * Transitional compatibility helper kept only until mapper-in extraction in phase 1.6.
 */
export function getGptFallback(isThinking: boolean): string {
  return isThinking ? LEGACY_GPT_FALLBACKS.thinking : LEGACY_GPT_FALLBACKS.default;
}

/**
 * Transitional compatibility helper for legacy sandbox tier resolution.
 */
export function resolveSandboxTieredModel(baseModel: string, extractedTier?: string): string | undefined {
  const normalized = normalizeModelId(baseModel);
  const defaultTier = SANDBOX_TIER_DEFAULTS[normalized];
  if (!defaultTier) {
    return undefined;
  }

  const resolved = `${normalized}-${extractedTier ?? defaultTier}`;
  return getModelSpec(resolved)?.modelId;
}

/**
 * Transitional compatibility helper for models that should pass through unchanged.
 */
export function isSandboxPassthroughModel(baseModel: string): boolean {
  const normalized = normalizeModelId(baseModel);
  return SANDBOX_PASSTHROUGH_MODELS.some((prefix) => normalized.includes(prefix));
}

/**
 * Transitional compatibility helper for default thinking budgets.
 */
export function getThinkingBudget(tier?: string): number {
  if (tier && tier in THINKING_BUDGET_DEFAULTS) {
    return THINKING_BUDGET_DEFAULTS[tier as keyof typeof THINKING_BUDGET_DEFAULTS];
  }

  return THINKING_BUDGET_DEFAULTS.default;
}

/**
 * Transitional compatibility helper that detects models using thinkingLevel mode.
 */
export function usesThinkingLevel(modelId: string): boolean {
  const normalized = normalizeModelId(modelId).replace(/-preview$/i, '');
  const modelSpec = getModelSpec(normalized);
  return modelSpec?.thinkingMode === 'level';
}

/**
 * Transitional compatibility helper for legacy transform defaults.
 */
export function getDefaultThinkingLevel(): string {
  return DEFAULT_THINKING_LEVEL;
}

/**
 * Transitional compatibility helper for legacy transform defaults.
 */
export function getMaxOutputTokens(isThinking: boolean): number {
  return isThinking ? 64000 : 4096;
}

/**
 * Provider-local model registry for the antigravity provider.
 */
export const antigravityModelRegistry: IModelRegistry = {
  getSpec(modelId: string): IModelSpec | null {
    return getModelSpec(modelId);
  },
  listModelIds(): string[] {
    return Object.keys(MODEL_REGISTRY).sort();
  },
};
