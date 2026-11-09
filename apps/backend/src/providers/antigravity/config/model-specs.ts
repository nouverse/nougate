/**
 * The models Antigravity offers: the ones Google's `fetchAvailableModels` lists for the accounts.
 *
 * No id is written down here. `api/models.ts` asks every account and keeps the union; the last good
 * answer is kept on disk (`core/live-models.ts`). Each account is still offered only the models its
 * own list has (`isModelUnlistedFor` in `auth/manager.ts`), since Google moves accounts to a new
 * generation one by one.
 *
 * ## What is offered, from the reply's own fields
 *
 * A model the reply marks internal (`isInternal`, `API_PROVIDER_INTERNAL`: Antigravity's own chat
 * helpers) is not offered, nor one it gives no display name (its tab-completion models), unless the
 * reply names it in `tieredModelIds`: that is a model served at levels, below. Ids the reply gives the
 * same display name are one model offered once: on 2026-11-09 `gemini-2.5-flash`, `-lite` and
 * `-thinking` were each named "Gemini 3.5 Flash Lite" beside `gemini-3.5-flash-lite` itself.
 *
 * A notice the reply attaches (`tagDescription`) is text for a person and is not read: on 2026-11-09
 * one said GPT-OSS would be removed on the 18th, and another, on the account moved to Claude 5.5,
 * that third-party models leave its plan on that day too. A model Google removes leaves its list,
 * and this one follows within six hours.
 *
 * ## How a request for it is shaped
 *
 * Each spec carries the reply's facts — the maker, whether it thinks by level, the file types it
 * takes, its output limit and window — and `config/shape.ts` shapes the Google request by them.
 * What the reply does not say is a rule, by maker or by Google's naming, never by exact model:
 *
 * - **Levels of a tiered model.** A model the reply lists as `<family>-tiered` is sent at
 *   `<family>-low`, `-medium` and `-high`, Google's own ids for its levels; `<family>` alone is sent
 *   as `-medium`. Claude 5.5's levels the reply lists one by one.
 * - **Budget for Claude thinking by budget.** An Anthropic model that thinks and states no level
 *   (Claude 4.6) is given a 32,768-token thinking budget unless the client asks for another. The
 *   reply's own `thinkingBudget` for it is 1,024, the least Anthropic allows; sent as the default it
 *   would cut the thinking short. A Google model is sent no budget, and thinks as Google decides.
 * - **An output limit the reply does not state**: 8,192, a conservative default.
 *
 * Prices: none; the shared price book prices each model by its family.
 */

import type { IModelSpec, InputModality } from '@/core/interfaces';
import { LayeredModelRegistry, statedTokens } from '@/core/live-models';
import { dataPath } from '@/core/paths';
import { withRouteModalities } from '@/providers/antigravity/config/audio';
import type { AntigravityModelSpec } from '@/providers/antigravity/config/shape';

const TIMEOUT_MS = 60_000;

/** The output limit of a listed model whose entry states none: a conservative default. */
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

/** The thinking budget an Anthropic model that thinks by budget is sent when the client names none. */
const ANTHROPIC_THINKING_BUDGET = 32_768;

/** Google's ids for the levels of a tiered model; the family alone is the middle one. */
const TIER_LEVELS = ['low', 'medium', 'high'] as const;
const TIER_ALIAS_LEVEL = 'medium';

/** One model as the reply's own fields describe it: what is kept on disk between answers. */
export interface AntigravityListedModel {
  /** Google's id. */
  id: string;
  name: string;
  /** Who made it, from `modelProvider`; absent when the reply does not say. */
  maker?: string;
  images: boolean;
  audio: boolean;
  thinking: boolean;
  /** Set when it thinks by level (`thinkingLevel`), not by a budget. */
  thinkingLevel?: number;
  maxOutputTokens?: number;
  /** The window (`maxTokens`). */
  window?: number;
  /** Served at levels: `<family>-low|medium|high`. */
  tiered: boolean;
}

/** `MODEL_PROVIDER_ANTHROPIC` → `anthropic`; failing that, the maker named in `apiProvider`. */
function makerOf(entry: any): string | undefined {
  const provider = typeof entry?.modelProvider === 'string' ? entry.modelProvider : '';
  const named = /^MODEL_PROVIDER_([A-Z]+)$/.exec(provider)?.[1];
  if (named) return named.toLowerCase();
  const api = typeof entry?.apiProvider === 'string' ? entry.apiProvider : '';
  return /ANTHROPIC|GOOGLE|OPENAI/.exec(api)?.[0]?.toLowerCase();
}

/** A name for a tiered family the reply names nothing: `gemini-3.8-flash` → `Gemini 3.8 Flash`. */
function familyName(family: string): string {
  return family
    .split('-')
    .map((word) => (word ? word[0]!.toUpperCase() + word.slice(1) : word))
    .join(' ');
}

/** A display name in id form, to tell which of several ids sharing it is the model's own. */
const asId = (name: string) => name.trim().toLowerCase().replace(/\s+/g, '-');

/** The models a `fetchAvailableModels` reply offers, as its own fields describe them. */
export function parseListedModels(reply: any): AntigravityListedModel[] {
  const raw = reply?.models ?? reply?.availableModels;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const tieredIds = new Set<string>(
    Object.values(reply?.tieredModelIds ?? {}).flatMap((ids) => (Array.isArray(ids) ? ids.map(String) : [])),
  );

  const listed: AntigravityListedModel[] = [];
  for (const [key, entry] of Object.entries<any>(raw)) {
    if (!entry || typeof entry !== 'object') continue;
    const id = key.replace('models/', '');
    if (entry.isInternal === true || entry.apiProvider === 'API_PROVIDER_INTERNAL') continue;
    const name = typeof entry.displayName === 'string' ? entry.displayName.trim() : '';
    const tiered = !name && tieredIds.has(id);
    if (!name && !tiered) continue;
    const mimeTypes = Object.keys(entry.supportedMimeTypes ?? {});
    const level = typeof entry.thinkingLevel === 'number' ? entry.thinkingLevel : undefined;
    const maxOutputTokens = statedTokens(entry.maxOutputTokens);
    const window = statedTokens(entry.maxTokens);
    const maker = makerOf(entry);
    listed.push({
      id,
      name: name || familyName(id.replace(/-tiered$/, '')),
      ...(maker ? { maker } : {}),
      images: entry.supportsImages === true || mimeTypes.some((type) => type.startsWith('image/')),
      audio: mimeTypes.some((type) => type.startsWith('audio/')),
      thinking: entry.supportsThinking === true,
      ...(level !== undefined ? { thinkingLevel: level } : {}),
      ...(maxOutputTokens ? { maxOutputTokens } : {}),
      ...(window ? { window } : {}),
      tiered,
    });
  }

  // Ids the reply gives one display name are one model: the one whose id is that name, else the first.
  const byName = new Map<string, AntigravityListedModel[]>();
  for (const model of listed) byName.set(model.name, [...(byName.get(model.name) ?? []), model]);
  const kept = new Set<AntigravityListedModel>();
  for (const [name, models] of byName) {
    const sorted = [...models].sort((a, b) => a.id.localeCompare(b.id));
    kept.add(sorted.find((model) => model.id === asId(name)) ?? sorted[0]!);
  }
  return listed.filter((model) => kept.has(model));
}

/** One listed model's specs: itself, or a tiered one's alias and levels. */
function specsOf(model: AntigravityListedModel): AntigravityModelSpec[] {
  const inputModalities: InputModality[] = ['text', ...(model.images ? ['image' as const] : []), ...(model.audio ? ['audio' as const] : [])];
  const byBudget = model.maker === 'anthropic' && model.thinking && model.thinkingLevel === undefined;
  const base: Omit<AntigravityModelSpec, 'modelId'> = {
    displayName: model.name,
    pool: 'sandbox',
    isThinking: model.thinking,
    ...(model.thinking ? { thinkingMode: 'budget' as const } : {}),
    ...(byBudget ? { thinkingBudget: ANTHROPIC_THINKING_BUDGET } : {}),
    maxOutputTokens: model.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    ...(model.window ? { contextWindow: model.window } : {}),
    timeoutMs: TIMEOUT_MS,
    inputModalities,
    ...(model.maker ? { maker: model.maker } : {}),
    thinksByLevel: model.thinkingLevel !== undefined,
  };
  if (!model.tiered) return [{ ...base, modelId: model.id }];

  // The level is in the id Google is sent, so a level is thinking by level, whatever the family says.
  const family = model.id.replace(/-tiered$/, '');
  return [
    { ...base, modelId: family, upstreamModelId: `${family}-${TIER_ALIAS_LEVEL}`, thinksByLevel: true },
    ...TIER_LEVELS.map((level) => ({
      ...base,
      modelId: `${family}-${level}`,
      displayName: `${model.name} (${level[0]!.toUpperCase()}${level.slice(1)})`,
      thinksByLevel: true,
    })),
  ];
}

/** The specs a set of listed models makes. */
export function antigravitySpecs(models: AntigravityListedModel[]): AntigravityModelSpec[] {
  return models.flatMap(specsOf);
}

/** An operator's own changes, from `providers/antigravity/model-specs.json`. Empty unless one wrote some. */
const OVERRIDES: Record<string, Partial<IModelSpec>> = {};

/**
 * Build a concrete model spec for an override naming a model Google does not list.
 */
function createDefaultModelSpec(modelId: string, override: Partial<IModelSpec>): IModelSpec {
  return {
    modelId,
    pool: override.pool ?? 'sandbox',
    isThinking: override.isThinking ?? false,
    maxOutputTokens: override.maxOutputTokens ?? 4096,
    timeoutMs: override.timeoutMs ?? TIMEOUT_MS,
    ...override,
  };
}

/**
 * Normalize a model identifier before doing registry lookups.
 */
function normalizeModelId(modelId: string): string {
  return modelId.trim().toLowerCase();
}

/**
 * Read the operator's override file into `OVERRIDES`, replacing what it held: a change the file no
 * longer has is gone. Each entry is laid over Google's spec of that model, or, for a model Google
 * does not list, made a whole spec of its own.
 */
export async function loadModelSpecOverrides(): Promise<void> {
  const path = dataPath('providers', 'antigravity', 'model-specs.json');
  try {
    const file = Bun.file(path);
    const overrides = (await file.exists()) ? ((await file.json()) as Record<string, Partial<IModelSpec>>) : {};
    for (const key of Object.keys(OVERRIDES)) delete OVERRIDES[key];
    for (const [rawModelId, override] of Object.entries(overrides)) {
      const modelId = normalizeModelId(rawModelId);
      OVERRIDES[modelId] = { ...OVERRIDES[modelId], ...override };
    }
    if (Object.keys(OVERRIDES).length > 0) console.log(`[AntigravityModelRegistry] Loaded overrides from ${path}`);
  } catch (error) {
    console.warn(`[AntigravityModelRegistry] Failed to load overrides from ${path}:`, error);
  }
}

const layered = new LayeredModelRegistry({ overrides: OVERRIDES, complete: createDefaultModelSpec, key: normalizeModelId });

/**
 * A default spec, for an id Google's lists do not show: it states nothing Google said. An id asked for
 * by name is still taken, and shaped by reading it, the one thing known (`config/shape.ts`); whether
 * thinking is on is read off it the same way. It reaches an account whose own list has it or that has
 * no list yet; when every account has a list and none has it, the request is answered with a 404 that
 * names it before anyone is asked, because Google answers such a model with "no longer available" as
 * a 200 reply, which reads like the model's answer (`isModelUnlistedFor`).
 */
function unlistedSpec(modelId: string): IModelSpec | null {
  const id = normalizeModelId(modelId);
  if (!id) return null;
  const thinking = id.includes('thinking');
  return createDefaultModelSpec(id, {
    isThinking: thinking,
    ...(thinking ? { thinkingMode: 'budget' as const, thinkingBudget: ANTHROPIC_THINKING_BUDGET } : {}),
    maxOutputTokens: 64000,
  });
}

/**
 * Provider-local model registry for the antigravity provider. A spec handed out carries the route's
 * modalities (`config/audio.ts`).
 */
export const antigravityModelRegistry = {
  getSpec(modelId: string): IModelSpec | null {
    const spec = layered.getSpec(modelId) ?? unlistedSpec(modelId);
    return spec ? withRouteModalities(spec) : null;
  },
  listModelIds(): string[] {
    return layered.listModelIds();
  },
  liveModelIds(): string[] {
    return layered.liveModelIds();
  },
  mergeLive(specs: IModelSpec[]): number {
    return layered.mergeLive(specs);
  },
};

/**
 * Read a model spec with exact provider-local lookup semantics.
 */
export function getModelSpec(modelId: string): IModelSpec | null {
  return antigravityModelRegistry.getSpec(modelId);
}

/**
 * The id Google knows a model by, the one the mappers send: the spec's `upstreamModelId` when it
 * names one, so `gemini-3.8-flash` is `gemini-3.8-flash-medium`. An id no list has is sent as it is
 * (`unlistedSpec`), so it is its own upstream id.
 */
export function upstreamModelIdFor(modelId: string): string {
  const modelSpec = layered.getSpec(modelId);
  return modelSpec ? (modelSpec.upstreamModelId ?? modelSpec.modelId) : modelId;
}
