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

/** Every registry back to what no answer has filled. */
export function clearSeeds(): void {
  codexModelRegistry.mergeLive([]);
}
