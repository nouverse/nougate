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

/** Every registry back to what no answer has filled. */
export function clearSeeds(): void {
  codexModelRegistry.mergeLive([]);
  claudeCodeModelRegistry.mergeLive([]);
}
