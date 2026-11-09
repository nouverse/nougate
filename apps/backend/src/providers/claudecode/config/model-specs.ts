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
 *
 * ## The written list, and the one Anthropic gives
 *
 * On top of the list below come the models `GET /v1/models` lists for the credential
 * (`api/models.ts`). A written model keeps its spec, price included; one only Anthropic lists gets
 * the output limit and window its list states, no price, and the provider's other defaults.
 * Anthropic lists an older model by its dated snapshot (`claude-haiku-4-5-20251001`), which is the
 * model its undated id names; a snapshot whose undated id is listed already is not listed again.
 */

import type { IModelSpec } from '@/core/interfaces';
import { LayeredModelRegistry, statedTokens } from '@/core/live-models';

/**
 * Generous, because these models think: a single hard request on Opus at high effort can run for
 * minutes, and the 60s every other provider uses would cut off the answers worth having.
 */
const TIMEOUT_MS = 600_000;

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
  timeoutMs: TIMEOUT_MS,
  inputPricePer1M,
  outputPricePer1M,
});

const MODEL_REGISTRY: Record<string, IModelSpec> = {
  'claude-opus-5-5': spec('claude-opus-5-5', 'Claude Opus 5.5', 128_000, 5, 25),
  'claude-opus-5': spec('claude-opus-5', 'Claude Opus 5', 128_000, 5, 25),
  'claude-opus-4-8': spec('claude-opus-4-8', 'Claude Opus 4.8', 128_000, 5, 25),
  'claude-opus-4-7': spec('claude-opus-4-7', 'Claude Opus 4.7', 128_000, 5, 25),
  'claude-opus-4-6': spec('claude-opus-4-6', 'Claude Opus 4.6', 128_000, 5, 25),
  'claude-sonnet-5-5': spec('claude-sonnet-5-5', 'Claude Sonnet 5.5', 128_000, 2, 10),
  'claude-sonnet-5': spec('claude-sonnet-5', 'Claude Sonnet 5', 128_000, 2, 10),
  'claude-sonnet-4-6': spec('claude-sonnet-4-6', 'Claude Sonnet 4.6', 128_000, 3, 15),
  // List rate for prompts up to 100K tokens; above that Anthropic charges 0.5 / 2.5, which a flat
  // per-model rate cannot express, so long-prompt Haiku traffic is under-reported.
  'claude-haiku-5-5': spec('claude-haiku-5-5', 'Claude Haiku 5.5', 128_000, 0.1, 0.5),
  'claude-haiku-4-5': spec('claude-haiku-4-5', 'Claude Haiku 4.5', 64_000, 1, 5),
  'claude-fable-5-1': spec('claude-fable-5-1', 'Claude Fable 5.1', 128_000, 10, 50),
  'claude-fable-5': spec('claude-fable-5', 'Claude Fable 5', 128_000, 10, 50),
};

/**
 * Models that refuse `temperature`, `top_p` and `top_k`.
 *
 * Anthropic answers a 400 — "`temperature` is deprecated for this model" — rather than ignoring the
 * field, so a client that sets one gets no answer at all. It is per model and not per family:
 * `claude-sonnet-5` refuses, `claude-sonnet-4-6` accepts, and the same split runs through Opus. That
 * is why this is a list and not a rule; there is no reliable way to read it off the name.
 *
 * Listed explicitly rather than defaulted, because both defaults are wrong in a different direction.
 * Assume "accepts" and a new model 400s on every request that tunes sampling. Assume "refuses" and a
 * model that honours temperature silently stops honouring it. An explicit list makes the question
 * visible when a model is added, which is the only place it can honestly be answered.
 *
 * Checked against the live API on 2026-09-06.
 */
const SAMPLING_DEPRECATED = new Set([
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-sonnet-5-5',
  'claude-sonnet-5',
  'claude-haiku-5-5',
  'claude-fable-5',
  'claude-fable-5-1',
]);

/** Whether this model rejects the sampling parameters outright. */
export function deprecatesSamplingParams(modelId: string): boolean {
  return SAMPLING_DEPRECATED.has(modelId) || SAMPLING_DEPRECATED.has(modelId.replace(/\./g, '-'));
}

/** Anthropic's ids are dashed; a client that writes the version with a dot (`claude-opus-5.5`) means the same model. */
const dashed = (modelId: string) => modelId.replace(/\./g, '-');

export const claudeCodeModelRegistry = new LayeredModelRegistry({ written: MODEL_REGISTRY, key: dashed });

export function getModelSpec(modelId: string): IModelSpec | null {
  return claudeCodeModelRegistry.getSpec(modelId);
}

/** One model as `GET /v1/models` lists it: the fields read here. */
export interface ClaudeListedModel {
  id?: string;
  type?: string;
  display_name?: string;
  /** The context window Anthropic states for it. */
  max_input_tokens?: number;
  /** The most one answer may hold. */
  max_tokens?: number;
}

/**
 * The output limit of a listed model whose list states none: a conservative default. Every model
 * Anthropic listed on 2026-11-09 stated its own, 64K or 128K.
 */
const DEFAULT_LIVE_MAX_OUTPUT_TOKENS = 32_000;

/** A dated snapshot id, `claude-haiku-4-5-20251001`: the date is its last segment. */
const SNAPSHOT_DATE = /-\d{8}$/;

/** The models a `/v1/models` list offers, as specs. */
export function claudeLiveSpecs(models: ClaudeListedModel[]): IModelSpec[] {
  const ids = new Set(models.map((model) => (typeof model?.id === 'string' ? dashed(model.id.trim()) : '')));
  const specs: IModelSpec[] = [];
  for (const model of models) {
    const id = typeof model?.id === 'string' ? dashed(model.id.trim()) : '';
    if (!id || (model.type !== undefined && model.type !== 'model')) continue;
    const undated = id.replace(SNAPSHOT_DATE, '');
    if (undated !== id && (Object.hasOwn(MODEL_REGISTRY, undated) || ids.has(undated))) continue;
    const contextWindow = statedTokens(model.max_input_tokens);
    specs.push({
      modelId: id,
      displayName: model.display_name?.trim() || id,
      pool: 'cli',
      isThinking: false,
      maxOutputTokens: statedTokens(model.max_tokens) ?? DEFAULT_LIVE_MAX_OUTPUT_TOKENS,
      upstreamModelId: id,
      timeoutMs: TIMEOUT_MS,
      ...(contextWindow ? { contextWindow } : {}),
    });
  }
  return specs;
}
