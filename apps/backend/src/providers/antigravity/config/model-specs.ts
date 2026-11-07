import type { IModelRegistry, IModelSpec } from '@/core/interfaces';
import { getProxyConfig } from '@/config/manager';
import { dataPath } from '@/core/paths';
import { withRouteModalities } from '@/providers/antigravity/config/audio';


const MODEL_REGISTRY: Record<string, IModelSpec> = {
  'gemini-3.1-flash-lite': {
    modelId: 'gemini-3.1-flash-lite',
    displayName: 'Gemini 3.1 Flash Lite',
    pool: 'sandbox',
    isThinking: false,
    maxOutputTokens: 8192,
    timeoutMs: 60000,
  },
  'gemini-3.1-flash-image': {
    modelId: 'gemini-3.1-flash-image',
    displayName: 'Gemini 3.1 Flash Image',
    pool: 'sandbox',
    isThinking: false,
    maxOutputTokens: 8192, // max: 65536
    timeoutMs: 60000,
  },
  // ── Gemini 3.8 Flash ──────────────────────────────────────────────────────
  // Google serves the thinking level as three ids of their own, so no budget is sent: one would
  // override the level the id names. The bare `gemini-3.8-flash` is not an upstream id; it stays
  // callable as Medium so a config that names it keeps working.
  'gemini-3.8-flash': {
    modelId: 'gemini-3.8-flash',
    displayName: 'Gemini 3.8 Flash',
    pool: 'sandbox',
    upstreamModelId: 'gemini-3.8-flash-medium',
    isThinking: true,
    thinkingMode: 'budget',
    maxOutputTokens: 65536,
    timeoutMs: 60000,
  },
  'gemini-3.8-flash-low': {
    modelId: 'gemini-3.8-flash-low',
    displayName: 'Gemini 3.8 Flash (Low)',
    pool: 'sandbox',
    isThinking: true,
    thinkingMode: 'budget',
    maxOutputTokens: 65536,
    timeoutMs: 60000,
  },
  'gemini-3.8-flash-medium': {
    modelId: 'gemini-3.8-flash-medium',
    displayName: 'Gemini 3.8 Flash (Medium)',
    pool: 'sandbox',
    isThinking: true,
    thinkingMode: 'budget',
    maxOutputTokens: 65536,
    timeoutMs: 60000,
  },
  'gemini-3.8-flash-high': {
    modelId: 'gemini-3.8-flash-high',
    displayName: 'Gemini 3.8 Flash (High)',
    pool: 'sandbox',
    isThinking: true,
    thinkingMode: 'budget',
    maxOutputTokens: 65536,
    timeoutMs: 60000,
  },
  'gemini-3-flash': {
    modelId: 'gemini-3-flash',
    displayName: 'Gemini 3 Flash',
    pool: 'sandbox',
    isThinking: true,
    thinkingMode: 'budget',
    maxOutputTokens: 65536,
    timeoutMs: 60000,
  },
  'gemini-3.5-flash-lite': {
    modelId: 'gemini-3.5-flash-lite',
    displayName: 'Gemini 3.5 Flash Lite',
    pool: 'sandbox',
    isThinking: false,
    maxOutputTokens: 65535,
    timeoutMs: 60000,
  },
  'gemini-2.5-pro': {
    modelId: 'gemini-2.5-pro',
    displayName: 'Gemini 2.5 Pro',
    pool: 'sandbox',
    isThinking: true,
    thinkingMode: 'budget',
    maxOutputTokens: 65535,
    timeoutMs: 60000,
  },
  'claude-sonnet-4-6': {
    modelId: 'claude-sonnet-4-6',
    displayName: 'Claude Sonnet 4.6 Thinking',
    pool: 'sandbox',
    isThinking: true,
    thinkingMode: 'budget',
    thinkingBudget: 32768,
    maxOutputTokens: 64000,
    timeoutMs: 60000,
  },
  'claude-opus-4-6-thinking': {
    modelId: 'claude-opus-4-6-thinking',
    displayName: 'Claude Opus 4.6 Thinking',
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
 *
 * Modalities are stamped on the way out rather than written into each entry: they follow from the
 * route (see `config/audio.ts`), so an entry added later — or an override-defined one — cannot
 * forget them.
 */
function cloneModelSpec(modelSpec: IModelSpec): IModelSpec {
  return withRouteModalities({
    ...modelSpec,
  });
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
  const paths = [dataPath('providers', 'antigravity', 'model-specs.json')];

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
      return cloneModelSpec(createDefaultModelSpec(modelId, {
        isThinking: modelId.toLowerCase().includes("thinking"),
        thinkingMode: modelId.toLowerCase().includes("thinking") ? "budget" : undefined,
        thinkingBudget: modelId.toLowerCase().includes("thinking") ? 32768 : undefined,
        maxOutputTokens: 64000,
      }));
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
