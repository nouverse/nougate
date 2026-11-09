/**
 * Kiro model registry.
 *
 * ## Variants are a gateway convention, not upstream models
 *
 * Kiro serves one id per model. `-thinking` and `-agentic` are suffixes this gateway accepts and
 * strips: `-thinking` turns reasoning on, `-agentic` prepends the chunked-write protocol. Both, in
 * that order, combine. They exist so a client that can only pick a model name — not set a
 * `reasoning_effort` — can still ask for either behaviour.
 *
 * ## Two sources, one snapshot
 *
 * The static catalogue below is what Kiro offered when this was written, and is what the gateway
 * serves before any account has answered `ListAvailableModels`. Once one has, models it reports
 * that are not listed here are added with the full variant set — so a release does not wait on a
 * code change. Lookups read an in-memory map; nothing on the request path awaits the network.
 *
 * ## Unpriced on purpose
 *
 * Kiro bills in credits against a subscription, scaled by a per-model `rateMultiplier`. That is not
 * a USD rate per million tokens, and inventing one would put a plausible-looking wrong number on
 * every cost chart. The multiplier is kept in `describeModel` for display instead.
 */

import type { IModelRegistry, IModelSpec, InputModality } from '@/core/interfaces';
import { parseThinkingSuffix } from './reasoning';

export const KIRO_AGENTIC_SUFFIX = '-agentic';
export const KIRO_THINKING_SUFFIX = '-thinking';

/** Kiro's own default `maxTokens` for a turn. */
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
  /** Credits charged per request relative to the base rate. */
  rateMultiplier?: number;
  description?: string;
  /** Modalities this model does not take. Kiro drops them silently, so the route refuses them. */
  strip?: InputModality[];
}

const GPT_56_DESCRIPTION = (name: string) =>
  `Experimental preview of OpenAI GPT 5.6 ${name} with 272k context window`;

export const KIRO_STATIC_MODELS: KiroModelDef[] = [
  // Opus 5.5 — experimental preview, 2x credits.
  { id: 'claude-opus-5.5', name: 'Claude Opus 5.5', variants: true, contextLength: 1_000_000 },
  { id: 'claude-opus-5', name: 'Claude Opus 5', variants: true, contextLength: 1_000_000 },
  { id: 'claude-opus-4.8', name: 'Claude Opus 4.8', variants: true, contextLength: 1_000_000 },
  { id: 'claude-opus-4.7', name: 'Claude Opus 4.7', variants: true, contextLength: 1_000_000 },
  { id: 'claude-opus-4.5', name: 'Claude Opus 4.5', variants: true, contextLength: 200_000 },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', variants: true, contextLength: 1_000_000 },
  { id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5', variants: true, contextLength: 200_000 },
  { id: 'claude-haiku-4.5', name: 'Claude Haiku 4.5', variants: true, contextLength: 200_000 },
  { id: 'deepseek-3.2', name: 'DeepSeek 3.2', variants: false, strip: ['image', 'audio'] },
  { id: 'qwen3-coder-next', name: 'Qwen3 Coder Next', variants: false, strip: ['image', 'audio'] },
  { id: 'glm-5', name: 'GLM 5', variants: false },
  { id: 'MiniMax-M2.5', name: 'MiniMax M2.5', variants: false },
  {
    id: 'gpt-5.6-sol',
    name: 'GPT 5.6 Sol',
    variants: true,
    contextLength: 272_000,
    rateMultiplier: 2.4,
    description: GPT_56_DESCRIPTION('Sol'),
  },
  {
    id: 'gpt-5.6-terra',
    name: 'GPT 5.6 Terra',
    variants: true,
    contextLength: 272_000,
    rateMultiplier: 1.2,
    description: GPT_56_DESCRIPTION('Terra'),
  },
  {
    id: 'gpt-5.6-luna',
    name: 'GPT 5.6 Luna',
    variants: true,
    contextLength: 272_000,
    rateMultiplier: 0.6,
    description: GPT_56_DESCRIPTION('Luna'),
  },
];

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
    maxOutputTokens: KIRO_MAX_OUTPUT_TOKENS,
    upstreamModelId: def.id,
    timeoutMs: KIRO_TIMEOUT_MS,
    inputModalities: inputModalities(def),
    // Kiro's own catalogue states it (`tokenLimits.maxInputTokens`), and the static list carries the same figure.
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
  tokenLimits?: { maxInputTokens?: number };
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
    defs.push({
      id,
      name,
      variants: true,
      contextLength: Number(entry.tokenLimits?.maxInputTokens) || undefined,
      ...(Number.isFinite(rate) ? { rateMultiplier: rate } : {}),
      ...(entry.description ? { description: entry.description } : {}),
    });
  }
  return defs;
}

/**
 * The model map behind `getSpec`. Static definitions are always present; live ones are layered on
 * and replaced wholesale each time a catalogue is merged.
 */
class KiroModelRegistry implements IModelRegistry {
  private defs = new Map<string, KiroModelDef>();
  private specs = new Map<string, IModelSpec>();
  /** Every spec by its id in lower case. One per model: a merge never adds an id that differs only in case. */
  private specsIgnoringCase = new Map<string, IModelSpec>();
  private liveIds = new Set<string>();

  constructor(staticDefs: KiroModelDef[]) {
    for (const def of staticDefs) this.defs.set(def.id, { ...def });
    this.rebuild();
  }

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
   * The definition an id names: exactly, or else one whose id differs only in case. The catalogue
   * spells a model as it likes (`minimax-m2.5` for the static `MiniMax-M2.5`, 2026-11-09), and read
   * exactly, the same model was listed twice, the second time without the static facts.
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

  /**
   * Add models a live catalogue reported that the static list does not know.
   *
   * Static definitions win on conflict — they carry hand-checked facts (stripped modalities, which
   * models take variants) the catalogue does not — except for the input window, where the upstream's
   * own figure beats a hand-copied one.
   */
  mergeLive(defs: KiroModelDef[]): number {
    for (const id of this.liveIds) this.defs.delete(id);
    this.liveIds.clear();
    let added = 0;
    for (const def of defs) {
      const known = this.definition(def.id);
      if (known) {
        if (def.contextLength) known.contextLength = def.contextLength;
        continue;
      }
      this.defs.set(def.id, def);
      this.liveIds.add(def.id);
      added++;
    }
    this.rebuild();
    return added;
  }

  /**
   * Accepts a `model(level)` override suffix; the override itself is read by the request mapper. An id
   * that differs from a listed one only in case is that model, so one picked under the catalogue's
   * spelling still resolves.
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
}

export const kiroModelRegistry = new KiroModelRegistry(KIRO_STATIC_MODELS);

export type { KiroModelRegistry };
