/**
 * What each upstream listed on 2026-11-09, for tests that need a provider to have models.
 *
 * A provider's models are the ones its upstream lists (`core/live-models.ts`), so a test that asks
 * for a spec seeds the registry first, through the provider's own derivation — the same path a real
 * answer takes — and clears it after. Test files share their modules: a seed left behind would show
 * in the next file's registry.
 *
 * Each answer is the one a live account gave, trimmed to the fields read and a few beside them.
 */

import { claudeCodeModelRegistry, claudeLiveSpecs, type ClaudeListedModel } from '@/providers/claudecode/config/model-specs';
import { codexLiveSpecs, codexModelRegistry, type CodexListedModel } from '@/providers/codex/config/model-specs';
import { copilotLiveSpecs, copilotModelRegistry, type CopilotListedModel } from '@/providers/copilot/config/model-specs';
import { catalogToModelDefs, kiroModelRegistry, type KiroCatalogEntry } from '@/providers/kiro/config/model-specs';

const codexListed = (slug: string, display_name: string, visibility: 'list' | 'hide', priority: number, supported_in_api = true) => ({
  slug,
  display_name,
  visibility,
  supported_in_api,
  priority,
  upgrade: null,
  context_window: 272000,
  max_context_window: 872000,
  input_modalities: ['text', 'image'],
  default_reasoning_level: 'medium',
});

/** `GET /backend-api/codex/models?client_version=0.190.0` for a Plus account. Three are hidden from the CLI's picker. */
export const CODEX_ANSWER: { models: CodexListedModel[] } = {
  models: [
    codexListed('gpt-6-chat-thinking', 'GPT-6 Chat Thinking', 'hide', 1, false),
    codexListed('gpt-reserve', 'GPT-Reserve', 'hide', 2),
    codexListed('gpt-6-luna', 'GPT-6-Luna', 'list', 3),
    codexListed('gpt-5.6-terra', 'GPT-5.6-Terra', 'list', 4),
    codexListed('gpt-5.6-luna', 'GPT-5.6-Luna', 'list', 5),
    codexListed('codex-auto-review', 'Codex Auto Review', 'hide', 6),
  ],
};

export function seedCodex(): void {
  codexModelRegistry.mergeLive(codexLiveSpecs(CODEX_ANSWER.models));
}

const claudeListed = (id: string, display_name: string, created_at: string, max_input_tokens: number, max_tokens: number) => ({
  type: 'model',
  id,
  display_name,
  created_at,
  line: id.split('-')[1],
  max_input_tokens,
  max_tokens,
});

/** `GET /v1/models` for a subscription login, newest first as Anthropic orders it. */
export const CLAUDE_ANSWER: ClaudeListedModel[] = [
  claudeListed('claude-haiku-5-5', 'Claude Haiku 5.5', '2026-10-07T18:00:00Z', 1_000_000, 128_000),
  claudeListed('claude-sonnet-5-5', 'Claude Sonnet 5.5', '2026-09-28T00:00:00Z', 1_000_000, 128_000),
  claudeListed('claude-opus-5-5', 'Claude Opus 5.5', '2026-09-21T16:24:00Z', 1_000_000, 128_000),
  claudeListed('claude-fable-5-1', 'Claude Fable 5.1', '2026-08-28T00:00:00Z', 1_000_000, 128_000),
  claudeListed('claude-opus-5', 'Claude Opus 5', '2026-07-24T00:00:00Z', 1_000_000, 128_000),
  claudeListed('claude-sonnet-5', 'Claude Sonnet 5', '2026-06-29T00:00:00Z', 1_000_000, 128_000),
  claudeListed('claude-fable-5', 'Claude Fable 5', '2026-06-07T00:00:00Z', 1_000_000, 128_000),
  claudeListed('claude-opus-4-8', 'Claude Opus 4.8', '2026-05-28T00:00:00Z', 1_000_000, 128_000),
  claudeListed('claude-opus-4-7', 'Claude Opus 4.7', '2026-04-14T00:00:00Z', 1_000_000, 128_000),
  claudeListed('claude-sonnet-4-6', 'Claude Sonnet 4.6', '2026-02-17T00:00:00Z', 1_000_000, 128_000),
  claudeListed('claude-opus-4-6', 'Claude Opus 4.6', '2026-02-04T00:00:00Z', 1_000_000, 128_000),
  claudeListed('claude-opus-4-5-20251101', 'Claude Opus 4.5', '2025-11-24T00:00:00Z', 200_000, 64_000),
  claudeListed('claude-haiku-4-5-20251001', 'Claude Haiku 4.5', '2025-10-15T00:00:00Z', 200_000, 64_000),
];

export function seedClaudeCode(): void {
  claudeCodeModelRegistry.mergeLive(claudeLiveSpecs(CLAUDE_ANSWER));
}

const MESSAGES_AND_CHAT = ['/v1/messages', '/chat/completions'];
const RESPONSES = ['/responses', 'ws:/responses'];

/** One entry as Copilot shapes it; `endpoints` undefined where the entry names none. */
const copilotEntry = (
  id: string,
  name: string,
  type: string,
  picker: boolean,
  policy: string | undefined,
  endpoints: string[] | undefined,
  limits: { out?: number; prompt?: number; window?: number },
): CopilotListedModel => ({
  id,
  name,
  object: 'model',
  version: id,
  preview: false,
  model_picker_enabled: picker,
  ...(policy ? { policy: { state: policy, terms: 'Enable access to the latest model.' } } : {}),
  capabilities: {
    type,
    family: id,
    limits: {
      ...(limits.window ? { max_context_window_tokens: limits.window } : {}),
      ...(limits.out ? { max_output_tokens: limits.out } : {}),
      ...(limits.prompt ? { max_prompt_tokens: limits.prompt } : {}),
    },
  },
  ...(endpoints ? { supported_endpoints: endpoints } : {}),
}) as CopilotListedModel;

/** `GET https://api.githubcopilot.com/models` for a Copilot account: every entry, nine of them offered. */
export const COPILOT_ANSWER: { data: CopilotListedModel[] } = {
  data: [
    copilotEntry('claude-haiku-5.5', 'Claude Haiku 5.5', 'chat', true, 'enabled', MESSAGES_AND_CHAT, { out: 100000, prompt: 100000, window: 200000 }),
    copilotEntry('claude-opus-4.8', 'Claude Opus 4.8', 'chat', true, 'enabled', MESSAGES_AND_CHAT, { out: 64000, prompt: 200000, window: 264000 }),
    copilotEntry('claude-opus-5.5', 'Claude Opus 5.5', 'chat', true, 'enabled', MESSAGES_AND_CHAT, { out: 128000, prompt: 200000, window: 328000 }),
    copilotEntry('claude-opus-5', 'Claude Opus 5', 'chat', true, 'enabled', MESSAGES_AND_CHAT, { out: 64000, prompt: 200000, window: 264000 }),
    copilotEntry('claude-sonnet-5.5', 'Claude Sonnet 5.5', 'chat', true, 'enabled', MESSAGES_AND_CHAT, { out: 128000, prompt: 200000, window: 328000 }),
    copilotEntry('claude-sonnet-5', 'Claude Sonnet 5', 'chat', true, 'enabled', MESSAGES_AND_CHAT, { out: 64000, prompt: 200000, window: 264000 }),
    copilotEntry('gemini-3.8-flash', 'Gemini 3.8 Flash', 'chat', true, 'enabled', ['/chat/completions'], { out: 65536, prompt: 200000, window: 265536 }),
    copilotEntry('gemini-4-argon', 'Gemini 4 Argon', 'chat', true, 'enabled', ['/chat/completions'], { out: 65536, prompt: 200000, window: 265536 }),
    copilotEntry('gpt-5.3-codex', 'GPT-5.3-Codex', 'chat', true, undefined, RESPONSES, { out: 128000, prompt: 272000, window: 400000 }),
    copilotEntry('gpt-5.4-nano', 'GPT-5.4 nano', 'chat', false, undefined, RESPONSES, { out: 128000, prompt: 272000, window: 400000 }),
    copilotEntry('gpt-5.6-luna', 'GPT-5.6 Luna', 'chat', true, 'enabled', RESPONSES, { out: 128000, prompt: 200000, window: 328000 }),
    copilotEntry('gpt-5.6-sol', 'GPT-5.6 Sol', 'chat', true, 'enabled', RESPONSES, { out: 128000, prompt: 272000, window: 400000 }),
    copilotEntry('gpt-5.6-terra', 'GPT-5.6 Terra', 'chat', true, 'enabled', RESPONSES, { out: 128000, prompt: 272000, window: 400000 }),
    copilotEntry('gpt-6.1-sol', 'GPT-6.1 Sol', 'chat', true, 'enabled', RESPONSES, { out: 128000, prompt: 272000, window: 400000 }),
    copilotEntry('gpt-6.1-terra', 'GPT-6.1 Terra', 'chat', true, undefined, RESPONSES, { out: 128000, prompt: 272000, window: 400000 }),
    copilotEntry('gpt-6-astra', 'GPT-6 Astra', 'chat', true, 'enabled', RESPONSES, { out: 128000, prompt: 272000, window: 400000 }),
    copilotEntry('gpt-6-luna-decisions', 'GPT-6 Luna Decisions', 'decisions', false, undefined, ['/v1/decisions'], { prompt: 872000, window: 1000000 }),
    copilotEntry('gpt-6-luna', 'GPT-6 Luna', 'chat', true, 'enabled', RESPONSES, { out: 128000, prompt: 272000, window: 400000 }),
    copilotEntry('gpt-6-sol', 'GPT-6 Sol', 'chat', true, 'enabled', RESPONSES, { out: 128000, prompt: 272000, window: 400000 }),
    copilotEntry('grok-4.6', 'Grok 4.6', 'chat', true, undefined, ['/responses'], { out: 128000, prompt: 200000, window: 328000 }),
    copilotEntry('grok-4.7', 'Grok 4.7', 'chat', true, undefined, ['/responses'], { out: 128000, prompt: 200000, window: 328000 }),
    copilotEntry('mai-code-1.1-flash', 'MAI-Code-1.1-Flash', 'chat', true, 'enabled', RESPONSES, { out: 128000, prompt: 128000, window: 256000 }),
    copilotEntry('gpt-4o-mini-2024-07-18', 'GPT-4o mini', 'chat', false, undefined, undefined, { out: 4096, prompt: 12288, window: 128000 }),
    copilotEntry('gpt-4o-2024-11-20', 'GPT-4o', 'chat', false, undefined, undefined, { out: 16384, prompt: 64000, window: 128000 }),
    copilotEntry('gpt-4o-2024-08-06', 'GPT-4o', 'chat', false, undefined, undefined, { out: 16384, prompt: 64000, window: 128000 }),
    copilotEntry('text-embedding-3-small', 'Embedding V3 small', 'embeddings', false, undefined, undefined, {}),
    copilotEntry('text-embedding-3-small-inference', 'Embedding V3 small (Inference)', 'embeddings', false, undefined, undefined, {}),
    copilotEntry('claude-haiku-4.5', 'Claude Haiku 4.5', 'chat', true, 'enabled', ['/chat/completions', '/v1/messages'], { out: 64000, prompt: 136000, window: 200000 }),
    copilotEntry('gpt-4.1-2025-04-14', 'GPT-4.1', 'chat', false, 'enabled', undefined, { out: 16384, prompt: 128000, window: 128000 }),
    copilotEntry('gpt-3.5-turbo-0613', 'GPT 3.5 Turbo', 'chat', false, undefined, undefined, { out: 4096, prompt: 12288, window: 16384 }),
    copilotEntry('gpt-4', 'GPT 4', 'chat', false, undefined, undefined, { out: 4096, prompt: 32768, window: 32768 }),
    copilotEntry('gpt-4-0613', 'GPT 4', 'chat', false, undefined, undefined, { out: 4096, prompt: 32768, window: 32768 }),
    copilotEntry('gpt-4-0125-preview', 'GPT 4 Turbo', 'chat', false, undefined, undefined, { out: 4096, prompt: 64000, window: 128000 }),
    copilotEntry('gpt-4o-2024-05-13', 'GPT-4o', 'chat', false, undefined, undefined, { out: 4096, prompt: 64000, window: 128000 }),
    copilotEntry('gpt-4-o-preview', 'GPT-4o', 'chat', false, undefined, undefined, { out: 4096, prompt: 64000, window: 128000 }),
    copilotEntry('gpt-4.1', 'GPT-4.1', 'chat', false, 'enabled', undefined, { out: 16384, prompt: 128000, window: 128000 }),
    copilotEntry('gpt-3.5-turbo', 'GPT 3.5 Turbo', 'chat', false, undefined, undefined, { out: 4096, prompt: 12288, window: 16384 }),
    copilotEntry('gpt-4o-mini', 'GPT-4o mini', 'chat', false, undefined, undefined, { out: 4096, prompt: 12288, window: 128000 }),
    copilotEntry('gpt-4o', 'GPT-4o', 'chat', false, undefined, undefined, { out: 4096, prompt: 64000, window: 128000 }),
    copilotEntry('text-embedding-ada-002', 'Embedding V2 Ada', 'embeddings', false, undefined, undefined, {}),
  ],
};

export function seedCopilot(): void {
  copilotModelRegistry.mergeLive(copilotLiveSpecs(COPILOT_ANSWER.data));
}

const kiroEntry = (
  modelId: string,
  modelName: string,
  description: string,
  rateMultiplier: number,
  supportedInputTypes: string[],
  maxInputTokens: number,
): KiroCatalogEntry & Record<string, unknown> => ({
  additionalModelRequestFieldsSchema: null,
  availableOrigins: null,
  description,
  modelId,
  modelName,
  rateMultiplier,
  rateUnit: 'Credit',
  supportedInputTypes,
  tokenLimits: { maxInputTokens, maxOutputTokens: 64000 },
});

/** `ListAvailableModels` for an AWS Builder ID account. */
export const KIRO_ANSWER: { models: KiroCatalogEntry[] } = {
  models: [
    kiroEntry('auto', 'Auto', 'Models chosen by task for optimal usage and consistent quality', 1, ['TEXT', 'IMAGE'], 1_000_000),
    kiroEntry('claude-sonnet-4.5', 'Claude Sonnet 4.5', 'Claude Sonnet 4.5 model', 1.3, ['TEXT', 'IMAGE'], 200_000),
    kiroEntry('claude-haiku-4.5', 'Claude Haiku 4.5', 'The latest Claude Haiku model', 0.4, ['TEXT', 'IMAGE'], 200_000),
    kiroEntry('deepseek-3.2', 'Deepseek v3.2', 'Experimental preview of DeepSeek V3.2', 0.25, ['TEXT'], 164_000),
    kiroEntry('minimax-m2.5', 'MiniMax M2.5', 'MiniMax M2.5 model', 0.25, ['TEXT'], 196_000),
    kiroEntry('minimax-m2.1', 'MiniMax M2.1', 'Experimental preview of MiniMax M2.1', 0.15, ['TEXT'], 196_000),
    kiroEntry('glm-5', 'GLM 5', 'GLM-5 model', 0.5, ['TEXT'], 200_000),
    kiroEntry('qwen3-coder-next', 'Qwen3 Coder Next', 'Experimental preview of Qwen3 Coder Next', 0.05, ['TEXT'], 256_000),
  ],
};

export function seedKiro(): void {
  kiroModelRegistry.mergeLive(catalogToModelDefs(KIRO_ANSWER.models));
}

/** Every registry back to what no answer has filled. */
export function clearSeeds(): void {
  codexModelRegistry.mergeLive([]);
  claudeCodeModelRegistry.mergeLive([]);
  copilotModelRegistry.mergeLive([]);
  kiroModelRegistry.mergeLive([]);
}
