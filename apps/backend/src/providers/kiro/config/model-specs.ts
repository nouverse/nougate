/**
 * The models Kiro offers: the ones `ListAvailableModels` lists for the account.
 *
 * No id is written down here. `index.ts` reads the catalogue; the last good answer is kept on disk
 * (`core/live-models.ts`). What a model takes is read from its own entry where the catalogue says:
 * its input types (`supportedInputTypes`), its window and output limit (`tokenLimits`), its credit
 * rate. What it does not say is below, as rules by family.
 *
 * ## Variants are a gateway convention, not upstream models
 *
 * Kiro serves one id per model. `-thinking` and `-agentic` are suffixes this gateway accepts and
 * strips: `-thinking` turns reasoning on, `-agentic` prepends the chunked-write protocol. Both, in
 * that order, combine. They exist so a client that can only pick a model name — not set a
 * `reasoning_effort` — can still ask for either behaviour.
 *
 * ## Unpriced on purpose
 *
 * Kiro bills in credits against a subscription, scaled by a per-model `rateMultiplier`. That is not
 * a USD rate per million tokens, and inventing one would put a plausible-looking wrong number on
 * every cost chart. The multiplier is kept in `describeModel` for display instead.
 */

import type { IModelRegistry, IModelSpec, InputModality } from '@/core/interfaces';
import { statedTokens } from '@/core/live-models';
import { parseThinkingSuffix } from './reasoning';

export const KIRO_AGENTIC_SUFFIX = '-agentic';
export const KIRO_THINKING_SUFFIX = '-thinking';

/**
 * Kiro's own default `maxTokens` for a turn: what a request asks for when the client names no limit,
 * and the output limit a model is described with when its entry states none.
 */
export const KIRO_MAX_OUTPUT_TOKENS = 32_000;

const KIRO_TIMEOUT_MS = 600_000;

export interface KiroModelDef {
  /** The upstream id. */
  id: string;
  name: string;
  /** Whether the synthetic `-thinking` / `-agentic` variants are offered. */
  variants: boolean;
  /**
   * Input window in tokens, when known. Left unset rather than defaulted: it scales Kiro's
   * context-usage percentage into a prompt token count, and a guessed window would make that count
   * a guess too.
   */
  contextLength?: number;
  /** The most one answer may hold, when the catalogue states it. */
  maxOutputTokens?: number;
  /** Credits charged per request relative to the base rate. */
  rateMultiplier?: number;
  description?: string;
  /** Modalities this model does not take. Kiro drops them silently, so the route refuses them. */
  strip?: InputModality[];
}

/**
 * The families whose reasoning Kiro carries, so whose models take the `-thinking` and `-agentic`
 * variants: Claude (a prompt tag and effort fields) and GPT (native effort), as `reasoning.ts` builds
 * them. The catalogue does not say which models reason; this is a rule by family, not a list. `auto`
 * picks one of them server-side, and takes `-thinking` only (`variantIds`).
 */
const VARIANT_FAMILIES = [/^claude-/i, /^gpt-/i, /^auto$/i];

function takesVariants(id: string): boolean {
  return VARIANT_FAMILIES.some((family) => family.test(id));
}

/** What a requested model id means once the gateway's suffixes are taken off. */
export interface KiroModelIntent {
  /** The id with only the `(level)` override removed — what the registry is keyed on. */
  model: string;
  /** The id Kiro is sent. */
  upstream: string;
  agentic: boolean;
  thinking: boolean;
}

/**
 * Strip `-agentic`, then `-thinking`, from a model id.
 *
 *   claude-sonnet-4.5-thinking-agentic → { upstream: claude-sonnet-4.5, agentic, thinking }
 */
export function resolveKiroModel(model: string): Omit<KiroModelIntent, 'model'> {
  let upstream = model;
  let agentic = false;
  let thinking = false;
  if (upstream.endsWith(KIRO_AGENTIC_SUFFIX)) {
    agentic = true;
    upstream = upstream.slice(0, -KIRO_AGENTIC_SUFFIX.length);
  }
  if (upstream.endsWith(KIRO_THINKING_SUFFIX)) {
    thinking = true;
    upstream = upstream.slice(0, -KIRO_THINKING_SUFFIX.length);
  }
  return { upstream, agentic, thinking };
}

/** Resolve a model id that may also carry a `model(level)` thinking override. */
export function resolveKiroModelIntent(model: string) {
  const { cleanModel, override } = parseThinkingSuffix(model);
  return { model: cleanModel, ...resolveKiroModel(cleanModel), thinkingOverride: override };
}

function variantIds(def: KiroModelDef): Array<{ id: string; label: string; thinking: boolean }> {
  const base = [{ id: def.id, label: def.name, thinking: false }];
  if (!def.variants) return base;
  base.push({ id: `${def.id}${KIRO_THINKING_SUFFIX}`, label: `${def.name} (Thinking)`, thinking: true });
  // `auto` lets Kiro pick the model server-side; a file-writing protocol aimed at one model means
  // nothing there.
  if (def.id === 'auto') return base;
  base.push(
    { id: `${def.id}${KIRO_AGENTIC_SUFFIX}`, label: `${def.name} (Agentic)`, thinking: false },
    {
      id: `${def.id}${KIRO_THINKING_SUFFIX}${KIRO_AGENTIC_SUFFIX}`,
      label: `${def.name} (Thinking + Agentic)`,
      thinking: true,
    },
  );
  return base;
}

function inputModalities(def: KiroModelDef): InputModality[] {
  // Kiro carries base64 images and nothing else; audio has no wire field at all.
  const offered: InputModality[] = ['text', 'image'];
  return offered.filter((modality) => !def.strip?.includes(modality));
}

function toSpecs(def: KiroModelDef): IModelSpec[] {
  return variantIds(def).map((variant) => ({
    modelId: variant.id,
    displayName: variant.label,
    pool: 'cli',
    isThinking: variant.thinking,
    ...(variant.thinking ? { thinkingMode: 'budget' as const, thinkingBudget: 16_000 } : {}),
    maxOutputTokens: def.maxOutputTokens ?? KIRO_MAX_OUTPUT_TOKENS,
    upstreamModelId: def.id,
    timeoutMs: KIRO_TIMEOUT_MS,
    inputModalities: inputModalities(def),
    // Kiro's own catalogue states it (`tokenLimits.maxInputTokens`).
    ...(def.contextLength ? { contextWindow: def.contextLength } : {}),
  }));
}

/** One model as `ListAvailableModels` reports it. */
export interface KiroCatalogEntry {
  modelId?: string;
  id?: string;
  modelName?: string;
  description?: string;
  rateMultiplier?: number;
  rateUnit?: string;
  /** `TEXT`, `IMAGE`: what the model takes. */
  supportedInputTypes?: string[];
  tokenLimits?: { maxInputTokens?: number; maxOutputTokens?: number };
}

/**
 * Turn a live catalogue into model definitions.
 *
 * The display name carries the credit multiplier when it is not 1x, since that is the one figure an
 * operator choosing between models needs and the dashboard has nowhere else to show it.
 */
export function catalogToModelDefs(entries: KiroCatalogEntry[]): KiroModelDef[] {
  const defs: KiroModelDef[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const raw = entry.modelId || entry.id;
    if (!raw) continue;
    const id = resolveKiroModel(raw).upstream;
    const base = (entry.modelName || id).trim();
    const rate = Number(entry.rateMultiplier);
    const name =
      Number.isFinite(rate) && rate > 0 && Math.abs(rate - 1) > 1e-9 ? `${base} (${rate.toFixed(1)}x credit)` : base;
    const types = Array.isArray(entry.supportedInputTypes) ? entry.supportedInputTypes.map((type) => String(type).toUpperCase()) : null;
    const maxOutputTokens = statedTokens(entry.tokenLimits?.maxOutputTokens);
    defs.push({
      id,
      name,
      variants: takesVariants(id),
      contextLength: Number(entry.tokenLimits?.maxInputTokens) || undefined,
      ...(maxOutputTokens ? { maxOutputTokens } : {}),
      ...(Number.isFinite(rate) ? { rateMultiplier: rate } : {}),
      ...(entry.description ? { description: entry.description } : {}),
      // An entry that names its input types and leaves images out does not take them. One that names
      // none says nothing, and images are carried as before.
      ...(types && !types.includes('IMAGE') ? { strip: ['image'] as InputModality[] } : {}),
    });
  }
  return defs;
}

/**
 * The model map behind `getSpec`: what the last catalogue listed, replaced whole by each one.
 */
class KiroModelRegistry implements IModelRegistry {
  private defs = new Map<string, KiroModelDef>();
  private specs = new Map<string, IModelSpec>();
  /** Every spec by its id in lower case. One per model: a merge never adds an id that differs only in case. */
  private specsIgnoringCase = new Map<string, IModelSpec>();

  private rebuild(): void {
    this.specs.clear();
    this.specsIgnoringCase.clear();
    for (const def of this.defs.values()) {
      for (const spec of toSpecs(def)) {
        this.specs.set(spec.modelId, spec);
        this.specsIgnoringCase.set(spec.modelId.toLowerCase(), spec);
      }
    }
  }

  /**
   * The definition an id names: exactly, or else one whose id differs only in case. Kiro names its
   * own models and refuses a spelling it no longer uses (it listed `minimax-m2.5` on 2026-11-09 and
   * refused `MiniMax-M2.5` with INVALID_MODEL_ID), so a client's other spelling is read as the listed
   * model and sent as it is listed (`upstreamSpelling`).
   */
  private definition(id: string): KiroModelDef | undefined {
    const exact = this.defs.get(id);
    if (exact) return exact;
    const lower = id.toLowerCase();
    for (const def of this.defs.values()) {
      if (def.id.toLowerCase() === lower) return def;
    }
    return undefined;
  }

  /** Make a catalogue's models the list. Two entries that differ only in case are one model, the first. */
  mergeLive(defs: KiroModelDef[]): number {
    this.defs.clear();
    for (const def of defs) {
      if (!this.definition(def.id)) this.defs.set(def.id, def);
    }
    this.rebuild();
    return this.defs.size;
  }

  /**
   * Accepts a `model(level)` override suffix; the override itself is read by the request mapper. An id
   * that differs from a listed one only in case is that model.
   */
  getSpec(modelId: string): IModelSpec | null {
    const clean = parseThinkingSuffix(modelId).cleanModel;
    return this.specs.get(clean) ?? this.specsIgnoringCase.get(clean.toLowerCase()) ?? null;
  }

  listModelIds(): string[] {
    return [...this.specs.keys()].sort();
  }

  /** The definition a spec came from, for context window and credit facts. */
  describeModel(modelId: string): KiroModelDef | null {
    const { upstream } = resolveKiroModel(parseThinkingSuffix(modelId).cleanModel);
    return this.definition(upstream) ?? null;
  }

  /**
   * The id Kiro is sent for an upstream id a client wrote: the spelling the catalogue lists the model
   * under. An id it does not list is sent as written.
   */
  upstreamSpelling(upstream: string): string {
    return this.definition(upstream)?.id ?? upstream;
  }
}

export const kiroModelRegistry = new KiroModelRegistry();

export type { KiroModelRegistry };
