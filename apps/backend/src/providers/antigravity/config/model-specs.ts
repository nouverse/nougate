/**
 * The models Antigravity offers, written by hand.
 *
 * ## Why Google's own list does not add models here
 *
 * The other providers lay their upstream's model list over their written one (`core/live-models.ts`).
 * Antigravity reads Google's list too — `fetchAvailableModels`, per account, kept as
 * `availableModels` (`api/quota.ts`) — but only to choose which account may serve a model
 * (`isModelUnlistedFor` in `auth/manager.ts`), never to add one, for two reasons.
 *
 * A Google request is assembled per model, and partly by its name: the mappers give function calls
 * an id only for `claude` and `gemini-3` ids, ask Claude for validated tool calls, send thought
 * signatures only to a thinking `gemini-3`, turn thinking on from the spec except for a `flash` id,
 * and the executor picks its headers by whether the id names Claude. A model Nougate has no written
 * spec for would be sent shaped for whichever family its name happens to match; a short answer could
 * come back while tool calls or thinking break.
 *
 * And what Google's list adds today is nothing a person should pick. On 2026-11-09 the ids two live
 * accounts listed beyond this file were: `gemini-2.5-flash`, `gemini-2.5-flash-lite` and
 * `gemini-2.5-flash-thinking`, each of which Google itself names "Gemini 3.5 Flash Lite", a model
 * listed here already; `gpt-oss-120b-medium`, whose own entry says "GPT-OSS will be removed from
 * Antigravity on November 18, 2026"; `gemini-3.8-flash-tiered`, the family the three Gemini 3.8 Flash
 * levels below are sent as; `chat_20706` and `chat_23310`, internal (`isInternal`); and two
 * `tab_*` completion models. A new model is added here, with the facts checked, when Google ships one.
 */

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
  // ── Claude 5.5 ────────────────────────────────────────────────────────────
  // Like Gemini 3.8 Flash, the thinking level is in Google's id, so no budget is sent. An account
  // Google has moved to 5.5 answers 4.6 with "no longer available" as the reply, and one not yet
  // moved answers 5.5 so: selection offers an account only the models its own list from Google
  // has (`isModelUnlistedFor` in auth/manager.ts).
  'claude-sonnet-5-5-low': {
    modelId: 'claude-sonnet-5-5-low',
    displayName: 'Claude Sonnet 5.5 (Low)',
    pool: 'sandbox',
    isThinking: true,
    thinkingMode: 'budget',
    maxOutputTokens: 128000,
    timeoutMs: 60000,
  },
  'claude-sonnet-5-5-medium': {
    modelId: 'claude-sonnet-5-5-medium',
    displayName: 'Claude Sonnet 5.5 (Medium)',
    pool: 'sandbox',
    isThinking: true,
    thinkingMode: 'budget',
    maxOutputTokens: 128000,
    timeoutMs: 60000,
  },
  'claude-sonnet-5-5-high': {
    modelId: 'claude-sonnet-5-5-high',
    displayName: 'Claude Sonnet 5.5 (High)',
    pool: 'sandbox',
    isThinking: true,
    thinkingMode: 'budget',
    maxOutputTokens: 128000,
    timeoutMs: 60000,
  },
  'claude-opus-5-5-low': {
    modelId: 'claude-opus-5-5-low',
    displayName: 'Claude Opus 5.5 (Low)',
    pool: 'sandbox',
    isThinking: true,
    thinkingMode: 'budget',
    maxOutputTokens: 128000,
    timeoutMs: 60000,
  },
  'claude-opus-5-5-medium': {
    modelId: 'claude-opus-5-5-medium',
    displayName: 'Claude Opus 5.5 (Medium)',
    pool: 'sandbox',
    isThinking: true,
    thinkingMode: 'budget',
    maxOutputTokens: 128000,
    timeoutMs: 60000,
  },
  'claude-opus-5-5-high': {
    modelId: 'claude-opus-5-5-high',
    displayName: 'Claude Opus 5.5 (High)',
    pool: 'sandbox',
    isThinking: true,
    thinkingMode: 'budget',
    maxOutputTokens: 128000,
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
 * The id Google knows a model by, the one the mappers send: the registry's `upstreamModelId` when it
 * names one, so `gemini-3.8-flash` is `gemini-3.8-flash-medium`. An id the registry does not hold is
 * sent as it is (see the bypass in `getModelSpec`), so it is its own upstream id.
 */
export function upstreamModelIdFor(modelId: string): string {
  const modelSpec = MODEL_REGISTRY[normalizeModelId(modelId)];
  return modelSpec ? (modelSpec.upstreamModelId ?? modelSpec.modelId) : modelId;
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
