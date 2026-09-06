/**
 * Codex model registry — all models from the 9router codex.js provider config.
 *
 * Models include:
 * - LLM models (many with auto-generated -review variants via quotaFamily)
 * - Image models with capabilities: ["text2img","edit"]
 *
 * Prices are not set because Codex is a subscription-backed provider (ChatGPT Plus/Pro).
 * The cost is zero marginal — these models draw on the subscription, not an API credit balance.
 */

import type { IModelRegistry, IModelSpec } from '@/core/interfaces';

const REVIEW_SUFFIX = '-review';

interface CodexModelDef {
  id: string;
  name: string;
  upstreamModelId?: string;
  quotaFamily?: string;
  capabilities?: string[];
  params?: string[];
  kind?: 'llm' | 'image';
}

const CODEX_MODELS: CodexModelDef[] = [
  { id: 'gpt-6-astra', name: 'GPT 6.0 Astra' },
  { id: 'gpt-5.6-sol', name: 'GPT 5.6 Sol' },
  { id: 'gpt-5.6-sol-review', name: 'GPT 5.6 Sol Review', upstreamModelId: 'gpt-5.6-sol', quotaFamily: 'review' },
  { id: 'gpt-5.6-terra', name: 'GPT 5.6 Terra' },
  { id: 'gpt-5.6-terra-review', name: 'GPT 5.6 Terra Review', upstreamModelId: 'gpt-5.6-terra', quotaFamily: 'review' },
  { id: 'gpt-5.6-luna', name: 'GPT 5.6 Luna' },
  { id: 'gpt-5.6-luna-review', name: 'GPT 5.6 Luna Review', upstreamModelId: 'gpt-5.6-luna', quotaFamily: 'review' },
  { id: 'gpt-5.5', name: 'GPT 5.5' },
  { id: 'gpt-5.5-review', name: 'GPT 5.5 Review', upstreamModelId: 'gpt-5.5', quotaFamily: 'review' },
  { id: 'gpt-5.4', name: 'GPT 5.4' },
  { id: 'gpt-5.4-review', name: 'GPT 5.4 Review', upstreamModelId: 'gpt-5.4', quotaFamily: 'review' },
  { id: 'gpt-5.4-mini', name: 'GPT 5.4 Mini' },
  { id: 'gpt-5.4-mini-review', name: 'GPT 5.4 Mini Review', upstreamModelId: 'gpt-5.4-mini', quotaFamily: 'review' },
  { id: 'gpt-5.3-codex-spark', name: 'GPT 5.3 Codex Spark' },
  { id: 'gpt-5.3-codex-spark-review', name: 'GPT 5.3 Codex Spark Review', upstreamModelId: 'gpt-5.3-codex-spark', quotaFamily: 'review' },
  // Image models
  { id: 'gpt-5.6-sol-image', name: 'GPT 5.6 Sol Image', capabilities: ['text2img', 'edit'], kind: 'image' },
  { id: 'gpt-5.6-terra-image', name: 'GPT 5.6 Terra Image', capabilities: ['text2img', 'edit'], kind: 'image' },
  { id: 'gpt-5.6-luna-image', name: 'GPT 5.6 Luna Image', capabilities: ['text2img', 'edit'], kind: 'image' },
  { id: 'gpt-5.5-image', name: 'GPT 5.5 Image', capabilities: ['text2img', 'edit'], kind: 'image' },
  { id: 'gpt-5.4-image', name: 'GPT 5.4 Image', capabilities: ['text2img', 'edit'], kind: 'image' },
  { id: 'gpt-5.3-image', name: 'GPT 5.3 Image', capabilities: ['text2img', 'edit'], kind: 'image' },
];

/** Thinking effort options supported by Codex. */
export const CODEX_THINKING_OPTIONS = ['auto', 'none', 'low', 'medium', 'high'] as const;
export const CODEX_EFFORT_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;

/** Resolve upstream model ID for review variants. */
export function getUpstreamModelId(modelId: string): string {
  const def = CODEX_MODELS.find((m) => m.id === modelId);
  return def?.upstreamModelId ?? modelId;
}

/** Check if a model is a review variant. */
export function isReviewModel(modelId: string): boolean {
  return modelId.endsWith(REVIEW_SUFFIX);
}

/** Check if a model is an image model. */
export function isImageModel(modelId: string): boolean {
  const def = CODEX_MODELS.find((m) => m.id === modelId);
  return def?.kind === 'image';
}

/** Strip -image suffix from model ID. */
export function stripImageSuffix(modelId: string): string {
  return modelId.endsWith('-image') ? modelId.slice(0, -6) : modelId;
}

function toModelSpec(def: CodexModelDef): IModelSpec {
  return {
    modelId: def.id,
    displayName: def.name,
    pool: 'cli',
    isThinking: false,
    maxOutputTokens: 128_000,
    upstreamModelId: def.upstreamModelId ?? def.id,
    timeoutMs: 600_000,
  };
}

const MODEL_REGISTRY: Record<string, IModelSpec> = {};
for (const def of CODEX_MODELS) {
  MODEL_REGISTRY[def.id] = toModelSpec(def);
}

export function getModelSpec(modelId: string): IModelSpec | null {
  return MODEL_REGISTRY[modelId] ?? null;
}

export const codexModelRegistry: IModelRegistry = {
  getSpec(modelId: string): IModelSpec | null {
    return getModelSpec(modelId);
  },
  listModelIds(): string[] {
    return Object.keys(MODEL_REGISTRY).sort();
  },
};
