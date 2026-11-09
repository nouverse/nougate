/**
 * The models this provider offers: the ones Anthropic's `/v1/models` lists for the credential.
 *
 * No id is written down here. `api/models.ts` reads the list, every page of it; the last good answer
 * is kept on disk (`core/live-models.ts`). What follows is what that list does not state.
 *
 * ## `isThinking` is false on every one of them, and that is not an oversight
 *
 * On Antigravity that flag decides whether the mapper turns thinking on, because a Google request
 * has to be assembled. Here the upstream *is* Anthropic and the anthropic protocol is a passthrough,
 * so `thinking` is the caller's parameter and arrives untouched.
 *
 * ## No prices
 *
 * The list states none, and an invented rate would put a plausible wrong number on every chart. The
 * shared price book still prices a model by its family (`core/metrics`), and on a subscription
 * credential the marginal cost is zero anyway.
 */

import type { IModelSpec } from '@/core/interfaces';
import { LayeredModelRegistry, statedTokens } from '@/core/live-models';

/**
 * Generous, because these models think: a single hard request on Opus at high effort can run for
 * minutes, and the 60s every other provider uses would cut off the answers worth having.
 */
const TIMEOUT_MS = 600_000;

/** Anthropic's ids are dashed; a client that writes the version with a dot (`claude-opus-5.5`) means the same model. */
const dashed = (modelId: string) => modelId.replace(/\./g, '-');

/** A dated snapshot id, `claude-haiku-4-5-20251001`: the date is its last segment. */
const SNAPSHOT_DATE = /-\d{8}$/;

/** The model an id names, whatever its spelling or snapshot: `claude-haiku-4.5-20251001` is `claude-haiku-4-5`. */
const undated = (modelId: string) => dashed(modelId.trim()).replace(SNAPSHOT_DATE, '');

/**
 * The models known to accept `temperature`, `top_p` and `top_k`. Every other model has them dropped.
 *
 * Anthropic answers a 400 — "`temperature` is deprecated for this model" — rather than ignoring the
 * field, so a client that sets one gets no answer at all from a model that refuses. It is per model
 * and not per family: `claude-sonnet-5` refuses, `claude-sonnet-4-6` accepts. The model list states
 * neither, so it is kept by hand, and only for the models that accept: every model Anthropic released
 * from Opus 4.7 (2026-04-14) on refuses, so a model this table does not name is far likelier to refuse
 * than to need them, and the two mistakes are not alike — a dropped temperature still answers, a
 * refused one does not.
 *
 * Checked against the live API on 2026-09-06. Names a model only to say this about it: a model this
 * table names that Anthropic does not list is not offered.
 */
const SAMPLING_ACCEPTED = new Set(['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5']);

/** Whether this model rejects the sampling parameters outright: any model not known to accept them. */
export function deprecatesSamplingParams(modelId: string): boolean {
  return !SAMPLING_ACCEPTED.has(undated(modelId));
}

/**
 * An id the list does not have under that spelling: the newest snapshot of the model it names, if the
 * list has one. Anthropic lists an older model only by a dated snapshot (`claude-haiku-4-5-20251001`)
 * and answers its undated id as an alias of it, so a client set up with `claude-haiku-4-5` still
 * reaches the model.
 */
function snapshotOf(modelId: string): IModelSpec | null {
  const model = undated(modelId);
  const snapshots = claudeCodeModelRegistry
    .listModelIds()
    .filter((id) => SNAPSHOT_DATE.test(id) && id.replace(SNAPSHOT_DATE, '') === model)
    .sort();
  const newest = snapshots.at(-1);
  return newest ? claudeCodeModelRegistry.getSpec(newest) : null;
}

export const claudeCodeModelRegistry = new LayeredModelRegistry({ written: {}, key: dashed, unknown: snapshotOf });

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
const DEFAULT_MAX_OUTPUT_TOKENS = 32_000;

/**
 * The models a `/v1/models` list offers, as specs. A dated snapshot whose undated id the list also
 * has is that model, and is not listed again.
 */
export function claudeLiveSpecs(models: ClaudeListedModel[]): IModelSpec[] {
  const ids = new Set(models.map((model) => (typeof model?.id === 'string' ? dashed(model.id.trim()) : '')));
  const specs: IModelSpec[] = [];
  for (const model of models) {
    const id = typeof model?.id === 'string' ? dashed(model.id.trim()) : '';
    if (!id || (model.type !== undefined && model.type !== 'model')) continue;
    const plain = id.replace(SNAPSHOT_DATE, '');
    if (plain !== id && ids.has(plain)) continue;
    const contextWindow = statedTokens(model.max_input_tokens);
    specs.push({
      modelId: id,
      displayName: model.display_name?.trim() || id,
      pool: 'cli',
      isThinking: false,
      maxOutputTokens: statedTokens(model.max_tokens) ?? DEFAULT_MAX_OUTPUT_TOKENS,
      upstreamModelId: id,
      timeoutMs: TIMEOUT_MS,
      ...(contextWindow ? { contextWindow } : {}),
    });
  }
  return specs;
}
