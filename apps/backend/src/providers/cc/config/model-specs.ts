/**
 * The models this provider offers, and what they cost.
 *
 * ## `isThinking` is false on every one of them, and that is not an oversight
 *
 * On Antigravity that flag decides whether the mapper turns thinking on, because a Google request
 * has to be assembled. Here the upstream *is* Anthropic and the anthropic protocol is a passthrough,
 * so `thinking` is the caller's parameter and arrives untouched. A flag claiming nougate enables
 * thinking would describe a decision nougate does not make — and on the current models it would be
 * describing it wrongly, since `budget_tokens` is rejected outright and depth is set with
 * `output_config.effort` instead.
 *
 * ## Prices are reference rates, and on a subscription credential they are fiction
 *
 * They exist so the dashboard can put a number on traffic. With an API key that number is the bill.
 * With an OAuth token the request draws on a subscription and the real marginal cost is zero — the
 * figure is then "what this would have cost at list", which is what the shared price book already
 * says about Copilot and Antigravity.
 *
 * Checked against Anthropic's published rates on 2026-06-24. They drift; when you change one, put
 * the date you checked in the commit message rather than in a comment that will rot.
 */

import type { IModelRegistry, IModelSpec } from '@/core/interfaces';

/** Every current model takes the same shape here, so the differences stay visible. */
const spec = (
  modelId: string,
  displayName: string,
  maxOutputTokens: number,
  inputPricePer1M: number,
  outputPricePer1M: number,
): IModelSpec => ({
  modelId,
  displayName,
  pool: 'cli',
  isThinking: false,
  maxOutputTokens,
  upstreamModelId: modelId,
  // Generous, because these models think: a single hard request on Opus at high effort can run for
  // minutes, and the 60s every other provider uses would cut off the answers worth having.
  timeoutMs: 600_000,
  inputPricePer1M,
  outputPricePer1M,
});

const MODEL_REGISTRY: Record<string, IModelSpec> = {
  'claude-opus-5': spec('claude-opus-5', 'Claude Opus 5', 128_000, 5, 25),
  'claude-opus-4-8': spec('claude-opus-4-8', 'Claude Opus 4.8', 128_000, 5, 25),
  'claude-sonnet-5': spec('claude-sonnet-5', 'Claude Sonnet 5', 128_000, 2, 10),
  'claude-sonnet-4-6': spec('claude-sonnet-4-6', 'Claude Sonnet 4.6', 128_000, 3, 15),
  'claude-haiku-4-5': spec('claude-haiku-4-5', 'Claude Haiku 4.5', 64_000, 1, 5),
  'claude-fable-5-1': spec('claude-fable-5-1', 'Claude Fable 5.1', 128_000, 10, 50),
};

export function getModelSpec(modelId: string): IModelSpec | null {
  return MODEL_REGISTRY[modelId] ?? null;
}

export const claudeCodeModelRegistry: IModelRegistry = {
  getSpec(modelId: string): IModelSpec | null {
    return getModelSpec(modelId);
  },
  listModelIds(): string[] {
    return Object.keys(MODEL_REGISTRY).sort();
  },
};
