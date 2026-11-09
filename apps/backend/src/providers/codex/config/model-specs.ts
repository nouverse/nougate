/**
 * The models Codex offers: the ones ChatGPT's own Codex model list offers the account.
 *
 * No id is written down here. `api/models.ts` reads `GET <base>/models` and keeps what the Codex
 * CLI shows a person to pick (`visibility: "list"`); the last good answer is kept on disk
 * (`core/live-models.ts`). What follows is what that list does not state.
 *
 * Prices are not set because Codex is a subscription-backed provider (ChatGPT Plus/Pro). The cost is
 * zero marginal: these models draw on the subscription, not an API credit balance.
 */

import type { IModelSpec } from '@/core/interfaces';
import { LayeredModelRegistry, statedTokens } from '@/core/live-models';

export const CODEX_EFFORT_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;

/**
 * The output figure a Codex model is described with. It bounds nothing upstream — Codex takes no
 * `max_output_tokens`, and `transformCodexRequest` strips one — and the model list states none.
 */
const CODEX_MAX_OUTPUT_TOKENS = 128_000;

/** Generous, because these models reason: a hard request at high effort runs for minutes. */
const CODEX_TIMEOUT_MS = 600_000;

export const codexModelRegistry = new LayeredModelRegistry();

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
      modelId: id,
      displayName: model.display_name?.trim() || id,
      pool: 'cli',
      isThinking: false,
      maxOutputTokens: CODEX_MAX_OUTPUT_TOKENS,
      upstreamModelId: id,
      timeoutMs: CODEX_TIMEOUT_MS,
      ...(contextWindow ? { contextWindow } : {}),
    });
  }
  return specs;
}
