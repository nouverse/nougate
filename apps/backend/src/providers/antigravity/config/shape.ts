/**
 * How a Google request is shaped for one model, from the facts Google's own model list gives it.
 *
 * Antigravity serves models of several makers through one Gemini-shaped request, and the makers do
 * not take it alike: Claude wants its tool calls validated and every call and answer to carry the
 * call's id; Gemini's level-thinking generation wants the ids too, and checks the thought signature
 * on a turn's first function call; only Gemini can be given Google Search. These used to be read off
 * the model's name (`includes('claude')`, `includes('gemini-3')`), which shapes a `gemini-4-*` or a
 * Claude named some new way wrongly with no error to point at.
 *
 * Now they are read from the spec, where `config/model-specs.ts` put what `fetchAvailableModels`
 * said about the model: its maker (`modelProvider`) and whether it thinks by level
 * (`thinkingLevel`). Where Google says nothing the request needs, the rule is by maker, never by
 * exact model: "an Anthropic model through Antigravity takes validated tool calls".
 */

import type { IModelSpec } from '@/core/interfaces';

/** What `fetchAvailableModels` said about a model, carried on its spec. */
export interface AntigravityModelFacts {
  /** Who made it, from the reply's `modelProvider`: `anthropic`, `google`, `openai`. */
  maker?: string;
  /**
   * Whether it thinks by level rather than by a token budget: the reply gives it a `thinkingLevel`.
   * Gemini 3 and later do (they replaced budgets with levels), and so does Claude 5.5, whose level
   * is in its id; Gemini 2.5 Pro and Claude 4.6 take a budget.
   */
  thinksByLevel?: boolean;
}

export type AntigravityModelSpec = IModelSpec & AntigravityModelFacts;

export interface RequestShape {
  /** Who made the model. */
  maker: string;
  /** Function calls and their answers carry the call's id: Claude, and Gemini's level-thinking generation. */
  callIds: boolean;
  /** A thinking model checks the thought signature on a turn's first function call: Gemini's level-thinking generation. */
  signatures: boolean;
  /** Tool calls are asked to be validated against their schema: Claude. */
  validatedTools: boolean;
  /** Google Search grounding can be attached: Gemini. */
  grounding: boolean;
  /** The request goes the way Antigravity sends Claude: its own endpoint and headers. */
  anthropic: boolean;
}

/**
 * The facts of a model Google did not list — an operator's override, or an id passed through by
 * `bypassModelValidation` — read off its id, the one thing known about it.
 */
function inferredFacts(spec: IModelSpec): Required<AntigravityModelFacts> {
  const id = (spec.upstreamModelId ?? spec.modelId).toLowerCase();
  const maker = id.includes('claude') ? 'anthropic' : /\bgpt\b|gpt-oss/.test(id) ? 'openai' : 'google';
  const generation = Number(/gemini-(\d+)/.exec(id)?.[1] ?? 0);
  return { maker, thinksByLevel: maker === 'google' && generation >= 3 };
}

/** The shape of the Google request for this model. */
export function shapeOf(spec: IModelSpec): RequestShape {
  const facts = spec as AntigravityModelSpec;
  const { maker, thinksByLevel } =
    facts.maker !== undefined ? { maker: facts.maker, thinksByLevel: facts.thinksByLevel ?? false } : inferredFacts(spec);
  const anthropic = maker === 'anthropic';
  const levelGemini = maker === 'google' && thinksByLevel;
  return {
    maker,
    callIds: anthropic || levelGemini,
    signatures: levelGemini,
    validatedTools: anthropic,
    grounding: maker === 'google',
    anthropic,
  };
}
