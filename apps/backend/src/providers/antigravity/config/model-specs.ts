import { existsSync } from 'fs';
import { join } from 'path';
import type { IModelRegistry, IModelSpec } from '@/core/interfaces';
import { getProxyConfig } from '@/config/manager';


const MODEL_REGISTRY: Record<string, IModelSpec> = {
  // ─── Gemini 3.5 ─────────────────────────────────────────────────────────────
  'gemini-3.5-flash-low': {
    modelId: 'gemini-3.5-flash-low',
    pool: 'sandbox',
    isThinking: true,
    thinkingMode: 'level',
    thinkingLevel: 'low',
    maxOutputTokens: 64000,
    timeoutMs: 60000,
  },
  // ─── Gemini 3.1 ─────────────────────────────────────────────────────────────
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
    upstreamModelId: 'gemini-3.1-pro',
    timeoutMs: 45000,
  },
  // ─── Gemini 2.5 ─────────────────────────────────────────────────────────────
  'gemini-2.5-flash': {
    modelId: 'gemini-2.5-flash',
    pool: 'sandbox',
    isThinking: false,
    maxOutputTokens: 4096,
    timeoutMs: 60000,
  },
  // ─── Claude (via Google Cloud Code) ─────────────────────────────────────────
  'claude-opus-4-6': {
    modelId: 'claude-opus-4-6',
    pool: 'sandbox',
    isThinking: false,
    maxOutputTokens: 8192,
    upstreamModelId: 'claude-opus-4-6-thinking',
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
  if (modelSpec) {
    return cloneModelSpec(modelSpec);
  }

  // Check if we should bypass validation
  try {
    const proxyConfig = getProxyConfig();
    if (proxyConfig && proxyConfig.bypassModelValidation) {
      // Dynamic fallback for unknown models to search/test raw upstream model names
      console.log(`[AntigravityModelRegistry] Unknown model "${modelId}" requested, generating dynamic spec fallback.`);
      return createDefaultModelSpec(modelId, {
        isThinking: modelId.toLowerCase().includes("thinking"),
        thinkingMode: modelId.toLowerCase().includes("thinking") ? "budget" : undefined,
        thinkingBudget: modelId.toLowerCase().includes("thinking") ? 32768 : undefined,
        maxOutputTokens: 64000,
      });
    }
  } catch (error) {
    // If config is not loaded (e.g. during specific standalone script runs), default to non-bypass
  }

  return null;
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

