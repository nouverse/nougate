/**
 * Model Specs Loader
 * 
 * Loads model specifications from config/model-specs.json.
 * Replaces hardcoded model lists and routing logic in transform.ts.
 */

import { join } from 'path';
import { existsSync } from 'fs';

// --- Types ---

export interface ModelSpecs {
  claudeRegistry: string[];
  nativelySupportedModels: string[];
  forceThinkingAliases: Record<string, string>;
  gptFallbacks: {
    thinking: string;
    default: string;
  };
  sandboxTieredModels: Record<string, string>;
  sandboxPassthroughModels: string[];
  thinkingBudgetDefaults: {
    low: number;
    medium: number;
    high: number;
    default: number;
  };
  thinkingConfig: {
    thinkingLevelModels: string[];
    defaultThinkingLevel: string;
  };
  maxOutputTokens: {
    thinking: number;
    default: number;
  };
}

// --- Defaults (used if JSON file is missing) ---

const DEFAULT_SPECS: ModelSpecs = {
  claudeRegistry: [
    "claude-3-7-sonnet-20250219",
    "claude-3-5-sonnet-20241022",
    "claude-3-5-sonnet-v2-20241022",
    "claude-3-5-sonnet-20240620",
    "claude-3-5-haiku-20241022",
    "claude-3-opus-20240229",
    "claude-opus-4-6-thinking",
    "claude-sonnet-4-6",
    "claude-sonnet-4-6-thinking",
    "claude-3-sonnet-20240229",
    "claude-3-haiku-20240307"
  ],
  nativelySupportedModels: [
    "claude-opus-4-6-thinking",
    "gemini-3.5-flash-low",
    "gemini-3.1-pro-high",
    "gemini-3.1-pro-low",
    "gemini-3.1-pro",
    "gemini-3.1-pro-preview",
    "gemini-3-flash",
    "gemini-3-pro-high",
    "gemini-3-pro-low",
    "gemini-3-pro",
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.5-flash-thinking",
    "gemini-3-pro-preview",
    "gemini-3-flash-preview",
    "gpt-oss-120b",
    "gpt-oss-120b-medium"
  ],
  forceThinkingAliases: {
    "claude-opus-4-6": "claude-opus-4-6-thinking",
    "claude-sonnet-4-6": "claude-sonnet-4-6-thinking",
    "claude-sonnet-4-5": "claude-sonnet-4-5-thinking",
    "antigravity-claude-opus-4-6": "claude-opus-4-6-thinking",
    "antigravity-claude-sonnet-4-6": "claude-sonnet-4-6-thinking",
    "antigravity-claude-sonnet-4-5": "claude-sonnet-4-5-thinking"
  },
  gptFallbacks: {
    thinking: "gemini-2.0-flash-thinking-exp",
    default: "gemini-2.0-pro-exp"
  },
  sandboxTieredModels: {
    "gemini-3.5-flash": "high",
    "gemini-3.1-pro": "high",
    "gemini-3-pro": "high"
  },
  sandboxPassthroughModels: [
    "gemini-3-flash",
    "gpt-oss"
  ],
  thinkingBudgetDefaults: {
    low: 8192,
    medium: 16000,
    high: 32768,
    default: 16000
  },
  thinkingConfig: {
    thinkingLevelModels: [
      "gemini-3-pro",
      "gemini-3.1-pro",
      "gemini-3.5-flash"
    ],
    defaultThinkingLevel: "low"
  },
  maxOutputTokens: {
    thinking: 64000,
    default: 4096
  }
};

// --- Loader ---

let specs: ModelSpecs;

const DEFAULT_PATH = existsSync("/app/data")
  ? "/app/data/config/model-specs.json"
  : join(process.cwd(), "config", "model-specs.json");

const SPECS_PATH = process.env.MODEL_SPECS_FILE || DEFAULT_PATH;

export async function loadModelSpecs(): Promise<ModelSpecs> {
  try {
    const file = Bun.file(SPECS_PATH);
    const exists = await file.exists();

    if (!exists) {
      console.log('[ModelSpecs] model-specs.json not found, using built-in defaults');
      specs = DEFAULT_SPECS;
      return specs;
    }

    const text = await file.text();
    const loaded = JSON.parse(text);

    // Strip _comment fields and merge with defaults
    const cleaned = stripComments(loaded);
    specs = { ...DEFAULT_SPECS, ...cleaned };

    console.log(`[ModelSpecs] Loaded: ${specs.claudeRegistry.length} Claude models, ${specs.nativelySupportedModels.length} native models, ${Object.keys(specs.forceThinkingAliases).length} aliases`);
    return specs;
  } catch (e) {
    console.error('[ModelSpecs] Failed to load model-specs.json, using defaults:', e);
    specs = DEFAULT_SPECS;
    return specs;
  }
}

export function getModelSpecs(): ModelSpecs {
  if (!specs) {
    // Synchronous fallback — should not happen if loadModelSpecs is called at startup
    console.warn('[ModelSpecs] Accessed before initialization, using defaults');
    specs = DEFAULT_SPECS;
  }
  return specs;
}

// --- Helper Functions ---

/**
 * Check if a model ID matches any entry in the Claude registry (fuzzy).
 * Returns the best matching Claude model ID, or undefined.
 */
export function resolveClaudeModel(cleanId: string): string | undefined {
  const registry = getModelSpecs().claudeRegistry;

  const exactMatch = registry.find(m => m === cleanId);
  if (exactMatch) return exactMatch;

  const baseId = cleanId.replace(/-(thinking|preview)(-(low|medium|high))?$/i, "");

  const fuzzyMatches = registry.filter(m =>
    m.startsWith(cleanId) || m.startsWith(baseId) || cleanId.startsWith(m)
  );

  if (fuzzyMatches.length > 0) {
    fuzzyMatches.sort((a, b) => b.localeCompare(a));
    return fuzzyMatches[0];
  }

  return undefined;
}

/**
 * Check if a model is natively supported.
 */
export function isNativelySupportedModel(googleModel: string, baseModel: string): boolean {
  const models = getModelSpecs().nativelySupportedModels;
  return models.includes(googleModel) || models.includes(baseModel);
}

/**
 * Apply force-thinking alias if applicable.
 * Returns the aliased model ID, or the original if no alias exists.
 */
export function applyThinkingAlias(modelId: string): string {
  const aliases = getModelSpecs().forceThinkingAliases;
  return aliases[modelId] || modelId;
}

/**
 * Get the GPT fallback model for CLI pool.
 */
export function getGptFallback(isThinking: boolean): string {
  const fallbacks = getModelSpecs().gptFallbacks;
  return isThinking ? fallbacks.thinking : fallbacks.default;
}

/**
 * Resolve the sandbox model with tier suffix.
 * Returns the model ID with tier appended, or undefined if not a tiered model.
 */
export function resolveSandboxTieredModel(baseModel: string, extractedTier?: string): string | undefined {
  const tieredModels = getModelSpecs().sandboxTieredModels;

  for (const [pattern, defaultTier] of Object.entries(tieredModels)) {
    if (baseModel.includes(pattern)) {
      return `${pattern}-${extractedTier || defaultTier}`;
    }
  }

  return undefined;
}

/**
 * Check if a model should pass through as-is in sandbox mode (no tier suffix).
 */
export function isSandboxPassthroughModel(baseModel: string): boolean {
  const passthroughModels = getModelSpecs().sandboxPassthroughModels;
  return passthroughModels.some(p => baseModel.includes(p));
}

/**
 * Get the default thinking budget for a given tier.
 */
export function getThinkingBudget(tier?: string): number {
  const budgets = getModelSpecs().thinkingBudgetDefaults;
  if (tier && tier in budgets) {
    return budgets[tier as keyof typeof budgets];
  }
  return budgets.default;
}

/**
 * Check if a model uses thinkingLevel (not thinkingBudget) for its thinkingConfig.
 */
export function usesThinkingLevel(googleModel: string): boolean {
  const levelModels = getModelSpecs().thinkingConfig.thinkingLevelModels;
  return levelModels.some(m => googleModel.includes(m));
}

/**
 * Get the default thinking level for models that use thinkingLevel.
 */
export function getDefaultThinkingLevel(): string {
  return getModelSpecs().thinkingConfig.defaultThinkingLevel;
}

/**
 * Get max output tokens configuration.
 */
export function getMaxOutputTokens(isThinking: boolean): number {
  const config = getModelSpecs().maxOutputTokens;
  return isThinking ? config.thinking : config.default;
}

// --- Internals ---

function stripComments(obj: any): any {
  if (Array.isArray(obj)) {
    return obj.filter(item => !(typeof item === 'string' && item.startsWith('_comment')));
  }
  if (obj && typeof obj === 'object') {
    const result: any = {};
    for (const [key, value] of Object.entries(obj)) {
      if (key === '_comment' || key === '$schema') continue;
      result[key] = stripComments(value);
    }
    return result;
  }
  return obj;
}
