/**
 * Codex model registry — all models from the 9router codex.js provider config.
 *
 * Models include:
 * - LLM models (many with auto-generated -review variants via quotaFamily)
 * - Image models with capabilities: ["text2img","edit"]
 *
 * Prices are not set because Codex is a subscription-backed provider (ChatGPT Plus/Pro).
 * The cost is zero marginal — these models draw on the subscription, not an API credit balance.
 *
 * ## The written list, and the one ChatGPT gives
 *
 * The list below is written by hand. On top of it come the models Codex's own model list offers an
 * account (`api/models.ts`): `visibility: "list"`, the ones the Codex CLI shows a person to pick.
 * A written model keeps its spec; one only the upstream lists gets the defaults below, unpriced.
 *
 * A live model gets no `-review` twin. A twin sends the same request as its model (`getUpstreamModelId`
 * maps it back, and nothing reads `quotaFamily`), so it would only be a second entry in a client's
 * picker for the same thing — and the newest written model, `gpt-6-astra`, has none.
 */

import type { IModelSpec } from '@/core/interfaces';
import { LayeredModelRegistry, statedTokens } from '@/core/live-models';


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
  { id: 'gpt-5.3-codex-spark-review', name: 'GPT 5.3 Codex Spark Review', upstreamModelId: 'gpt-5.3-codex-spark', quotaFamily: 'review' },];

export const CODEX_EFFORT_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;

/** Resolve upstream model ID for review variants. */
export function getUpstreamModelId(modelId: string): string {
  const def = CODEX_MODELS.find((m) => m.id === modelId);
  return def?.upstreamModelId ?? modelId;
}

/**
 * The output limit every Codex model here carries. It bounds nothing upstream — Codex takes no
 * `max_output_tokens`, and `transformCodexRequest` strips one — so it only describes the model.
 */
const CODEX_MAX_OUTPUT_TOKENS = 128_000;

const CODEX_TIMEOUT_MS = 600_000;

function toModelSpec(def: CodexModelDef): IModelSpec {
  return {
    modelId: def.id,
    displayName: def.name,
    pool: 'cli',
    isThinking: false,
    maxOutputTokens: CODEX_MAX_OUTPUT_TOKENS,
    upstreamModelId: def.upstreamModelId ?? def.id,
    timeoutMs: CODEX_TIMEOUT_MS,
  };
}

const MODEL_REGISTRY: Record<string, IModelSpec> = {};
for (const def of CODEX_MODELS) {
  MODEL_REGISTRY[def.id] = toModelSpec(def);
}

export const codexModelRegistry = new LayeredModelRegistry({ written: MODEL_REGISTRY });

export function getModelSpec(modelId: string): IModelSpec | null {
  return codexModelRegistry.getSpec(modelId);
}

/** One model as `GET /backend-api/codex/models` reports it: the fields read here. */
export interface CodexListedModel {
  slug?: string;
  display_name?: string;
  /** `list` is shown in the Codex CLI's picker; `hide` is not (its review model, experiments). */
  visibility?: string;
  context_window?: number;
}

/** The models a Codex model list offers a person to pick, as specs. */
export function codexLiveSpecs(models: CodexListedModel[]): IModelSpec[] {
  const specs: IModelSpec[] = [];
  for (const model of models) {
    const id = typeof model?.slug === 'string' ? model.slug.trim() : '';
    if (!id || model.visibility !== 'list') continue;
    const contextWindow = statedTokens(model.context_window);
    specs.push({
      ...toModelSpec({ id, name: model.display_name?.trim() || id }),
      ...(contextWindow ? { contextWindow } : {}),
    });
  }
  return specs;
}
