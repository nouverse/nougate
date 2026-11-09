/**
 * The models Copilot offers.
 *
 * ## The written list, and the one Copilot gives
 *
 * On top of the list below come the models Copilot's own `/models` lists for the account
 * (`upstream/models.ts`): the chat models its picker shows, whose policy is not `disabled`, served on
 * `/chat/completions`. Copilot states the endpoints that serve each model (`supported_endpoints`), and
 * this provider sends every request to `/chat/completions` (`upstream/executor.ts`), so a model it
 * serves only on `/responses` — its GPT-5 and later, Grok and MAI on 2026-11-09 — is not offered, and
 * the written list holds none either. A model whose entry names no endpoints is the older kind,
 * served there. A `/responses` path for this provider is what would bring those models back.
 *
 * A written model keeps its spec; one only Copilot lists gets the output limit its entry states, the
 * prompt limit as its window, no price, and the defaults below. An override file
 * (`loadModelSpecOverrides`) writes into the written list, so it wins too.
 */

import type { IModelSpec } from '@/core/interfaces';
import { getProxyConfig } from '@/config/manager';
import { LayeredModelRegistry, statedTokens } from '@/core/live-models';
import { dataPath } from '@/core/paths';

/**
 * Written models. Each is one Copilot serves on `/chat/completions` (`servedOnChatCompletions`):
 * its GPT-5.6 and GPT-6 models were here until 2026-11-09, when Copilot listed them for
 * `/responses` only and refused each on `/chat/completions` with `unsupported_api_for_model`.
 */
const MODEL_REGISTRY: Record<string, IModelSpec> = {
  'gpt-4o': {
    modelId: 'gpt-4o',
    displayName: 'GPT-4o',
    pool: 'cli',
    isThinking: false,
    maxOutputTokens: 4096,
    upstreamModelId: 'gpt-4o',
    timeoutMs: 60000,
  },
  'gpt-4.1': {
    modelId: 'gpt-4.1',
    displayName: 'GPT-4.1',
    pool: 'cli',
    isThinking: false,
    maxOutputTokens: 8192,
    upstreamModelId: 'gpt-4.1',
    timeoutMs: 60000,
  },
  'claude-haiku-5.5': {
    modelId: 'claude-haiku-5.5',
    displayName: 'Claude Haiku 5.5',
    pool: 'cli',
    isThinking: false,
    maxOutputTokens: 8192,
    upstreamModelId: 'claude-haiku-5.5',
    timeoutMs: 60000,
  },
  'claude-haiku-4.5': {
    modelId: 'claude-haiku-4.5',
    displayName: 'Claude Haiku 4.5',
    pool: 'cli',
    isThinking: false,
    maxOutputTokens: 8192,
    upstreamModelId: 'claude-haiku-4.5',
    timeoutMs: 60000,
  },
  'claude-sonnet-5.5': {
    modelId: 'claude-sonnet-5.5',
    displayName: 'Claude Sonnet 5.5',
    pool: 'cli',
    isThinking: false,
    maxOutputTokens: 8192,
    upstreamModelId: 'claude-sonnet-5.5',
    timeoutMs: 60000,
  },
  'claude-sonnet-5': {
    modelId: 'claude-sonnet-5',
    displayName: 'Claude Sonnet 5',
    pool: 'cli',
    isThinking: false,
    maxOutputTokens: 8192,
    upstreamModelId: 'claude-sonnet-5',
    timeoutMs: 60000,
  },
  'claude-opus-5': {
    modelId: 'claude-opus-5',
    displayName: 'Claude Opus 5',
    pool: 'cli',
    isThinking: false,
    maxOutputTokens: 8192,
    upstreamModelId: 'claude-opus-4.5',
    timeoutMs: 60000,
  },
  'claude-opus-5.5': {
    modelId: 'claude-opus-5.5',
    displayName: 'Claude Opus 5.5',
    pool: 'cli',
    isThinking: false,
    maxOutputTokens: 8192,
    upstreamModelId: 'claude-opus-5.5',
    timeoutMs: 60000,
  },
  'claude-fable-5': {
    modelId: 'claude-fable-5',
    displayName: 'Claude Fable 5',
    pool: 'cli',
    isThinking: false,
    maxOutputTokens: 8192,
    upstreamModelId: 'claude-fable-5',
    timeoutMs: 60000,
  },
  'claude-fable-5.1': {
    modelId: 'claude-fable-5.1',
    displayName: 'Claude Fable 5.1',
    pool: 'cli',
    isThinking: false,
    maxOutputTokens: 8192,
    upstreamModelId: 'claude-fable-5.1',
    timeoutMs: 60000,
  },
  'gemini-3.8-flash': {
    modelId: 'gemini-3.8-flash',
    displayName: 'Gemini 3.8 Flash',
    pool: 'cli',
    isThinking: false,
    maxOutputTokens: 8192,
    upstreamModelId: 'gemini-3.8-flash',
    timeoutMs: 60000,
  },
};

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

export async function loadModelSpecOverrides(): Promise<void> {
  const paths = [dataPath('providers', 'copilot', 'model-specs.json')];

  for (const path of paths) {
    try {
      const file = Bun.file(path);
      if (!(await file.exists())) {
        continue;
      }

      const overrides = await file.json() as Record<string, Partial<IModelSpec>>;
      for (const [rawModelId, override] of Object.entries(overrides)) {
        const modelId = normalizeModelId(rawModelId);
        const current = MODEL_REGISTRY[modelId];
        MODEL_REGISTRY[modelId] = current
          ? { ...current, ...override, modelId }
          : createDefaultModelSpec(modelId, override);
      }

      console.log(`[CopilotModelRegistry] Loaded overrides from ${path}`);
      return;
    } catch (error) {
      console.warn(`[CopilotModelRegistry] Failed to load overrides from ${path}:`, error);
    }
  }
}

/** What a lookup of an id neither list has gets: a made-up spec when the operator allows unknown models. */
function unknownModelSpec(modelId: string): IModelSpec | null {
  try {
    const proxyConfig = getProxyConfig();
    if (proxyConfig && proxyConfig.bypassModelValidation) {
      console.log(`[CopilotModelRegistry] Unknown model "${modelId}" requested, generating dynamic spec fallback.`);
      return createDefaultModelSpec(modelId, {
        isThinking: modelId.toLowerCase().includes("thinking") || modelId.toLowerCase().includes("o3"),
        maxOutputTokens: 8192,
      });
    }
  } catch (error) {
    // Standard fallback behavior if config manager isn't initialized/ready
  }

  return null;
}

export const copilotModelRegistry = new LayeredModelRegistry({
  written: MODEL_REGISTRY,
  key: normalizeModelId,
  unknown: unknownModelSpec,
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
 * The output limit of a listed model whose entry states none: a conservative default, the one most
 * written models here carry.
 */
const DEFAULT_LIVE_MAX_OUTPUT_TOKENS = 8192;

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
      maxOutputTokens: statedTokens(limits?.max_output_tokens) ?? DEFAULT_LIVE_MAX_OUTPUT_TOKENS,
      upstreamModelId: id,
      timeoutMs: COPILOT_TIMEOUT_MS,
      ...(contextWindow ? { contextWindow } : {}),
    });
  }
  return specs;
}
