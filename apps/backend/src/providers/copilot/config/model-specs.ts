/**
 * The models Copilot offers: the ones Copilot's own `/models` lists for the account.
 *
 * No id is written down here. `upstream/models.ts` reads the list and keeps the chat models Copilot's
 * picker shows, whose policy is not `disabled`, served on `/chat/completions`; the last good answer is
 * kept on disk (`core/live-models.ts`). Copilot states the endpoints that serve each model
 * (`supported_endpoints`), and this provider sends every request to `/chat/completions`
 * (`upstream/executor.ts`), so a model it serves only on `/responses` — its GPT-5 and later, Grok and
 * MAI on 2026-11-09 — is not offered. A model whose entry names no endpoints is the older kind,
 * served there. A `/responses` path for this provider is what would bring those models back.
 *
 * A model gets the output limit its entry states, the prompt limit as its window, no price, and the
 * defaults below. An operator's override file (`loadModelSpecOverrides`) writes specs of its own,
 * which win.
 */

import type { IModelSpec } from '@/core/interfaces';
import { LayeredModelRegistry, statedTokens } from '@/core/live-models';
import { dataPath } from '@/core/paths';

/** An operator's own changes, from `providers/copilot/model-specs.json`. Empty unless one wrote some. */
const OVERRIDES: Record<string, Partial<IModelSpec>> = {};

function createDefaultModelSpec(modelId: string, override: Partial<IModelSpec>): IModelSpec {
  return {
    modelId,
    pool: override.pool ?? 'cli',
    isThinking: override.isThinking ?? false,
    maxOutputTokens: override.maxOutputTokens ?? 4096,
    timeoutMs: override.timeoutMs ?? 60000,
    ...override,
  };
}

function normalizeModelId(modelId: string): string {
  return modelId.trim().toLowerCase();
}

/**
 * Read the operator's override file into `OVERRIDES`, replacing what it held: a change the file no
 * longer has is gone. Each entry is laid over the upstream's spec of that model, or, for a model the
 * upstream does not list, made a whole spec of its own.
 */
export async function loadModelSpecOverrides(): Promise<void> {
  const path = dataPath('providers', 'copilot', 'model-specs.json');
  try {
    const file = Bun.file(path);
    const overrides = (await file.exists()) ? ((await file.json()) as Record<string, Partial<IModelSpec>>) : {};
    for (const key of Object.keys(OVERRIDES)) delete OVERRIDES[key];
    for (const [rawModelId, override] of Object.entries(overrides)) {
      const modelId = normalizeModelId(rawModelId);
      OVERRIDES[modelId] = { ...OVERRIDES[modelId], ...override };
    }
    if (Object.keys(OVERRIDES).length > 0) console.log(`[CopilotModelRegistry] Loaded overrides from ${path}`);
  } catch (error) {
    console.warn(`[CopilotModelRegistry] Failed to load overrides from ${path}:`, error);
  }
}

/**
 * A default spec, for an id the account's list does not show: it states nothing about the model. The
 * list decides what is offered and where a bare id goes, but an id asked for by name is still sent,
 * and Copilot's own answer decides; a model it does not know comes back as a 404 that names it,
 * costing no account (`classifyUpstreamError`).
 */
function unlistedSpec(modelId: string): IModelSpec | null {
  const id = normalizeModelId(modelId);
  if (!id) return null;
  return createDefaultModelSpec(id, { maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS, upstreamModelId: id });
}

export const copilotModelRegistry = new LayeredModelRegistry({
  overrides: OVERRIDES,
  complete: createDefaultModelSpec,
  key: normalizeModelId,
  unknown: unlistedSpec,
});

export function getModelSpec(modelId: string): IModelSpec | null {
  return copilotModelRegistry.getSpec(modelId);
}

/** One model as Copilot's `/models` lists it: the fields read here. */
export interface CopilotListedModel {
  id?: string;
  name?: string;
  /** Whether Copilot's own picker shows it. */
  model_picker_enabled?: boolean;
  capabilities?: {
    /** `chat`, `embeddings`, `decisions`, … */
    type?: string;
    limits?: { max_output_tokens?: number; max_prompt_tokens?: number; max_context_window_tokens?: number };
  };
  /** Absent when the model needs no opt-in; `disabled` when the account's admin turned it off. */
  policy?: { state?: string };
  supported_endpoints?: string[];
}

/** The endpoint this provider sends every request to. */
const CHAT_ENDPOINT = '/chat/completions';

/**
 * Whether Copilot serves a listed model where this provider sends it. An entry that names no
 * endpoints is the older kind, served there.
 */
export function servedOnChatCompletions(model: CopilotListedModel): boolean {
  return !Array.isArray(model.supported_endpoints) || model.supported_endpoints.includes(CHAT_ENDPOINT);
}

/**
 * The output limit of a model whose entry states none, or that the list does not show: a conservative
 * default, the one most models written here by hand used to carry.
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

const COPILOT_TIMEOUT_MS = 60_000;

/** The models a Copilot `/models` list offers a person to pick, as specs. */
export function copilotLiveSpecs(models: CopilotListedModel[]): IModelSpec[] {
  const specs: IModelSpec[] = [];
  for (const model of models) {
    const id = typeof model?.id === 'string' ? model.id.trim() : '';
    if (!id || model.capabilities?.type !== 'chat' || model.model_picker_enabled !== true) continue;
    if (model.policy?.state === 'disabled') continue;
    if (!servedOnChatCompletions(model)) continue;
    const limits = model.capabilities.limits;
    // The prompt limit, not the larger window it shares with the answer: Copilot refuses a prompt past
    // it, and a client that budgets by the window would send one.
    const contextWindow = statedTokens(limits?.max_prompt_tokens);
    specs.push({
      modelId: id,
      displayName: model.name?.trim() || id,
      pool: 'cli',
      isThinking: false,
      maxOutputTokens: statedTokens(limits?.max_output_tokens) ?? DEFAULT_MAX_OUTPUT_TOKENS,
      upstreamModelId: id,
      timeoutMs: COPILOT_TIMEOUT_MS,
      ...(contextWindow ? { contextWindow } : {}),
    });
  }
  return specs;
}
