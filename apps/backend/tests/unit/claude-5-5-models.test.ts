/**
 * Claude Sonnet 5.5 and Haiku 5.5 across the providers that serve them.
 *
 * Each provider spells the id its own way — Claude Code uses the API's hyphenated form,
 * Copilot the dotted one — and a client may send either, so both spellings are asserted here.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { claudeCodeModelRegistry, deprecatesSamplingParams } from '@/providers/claudecode/config/model-specs';
import { copilotModelRegistry } from '@/providers/copilot/config/model-specs';
import { clearSeeds, seedClaudeCode, seedCopilot } from './fixtures/upstream-models';

// A provider's models are its upstream's: these are the ones Anthropic and Copilot listed.
beforeAll(() => {
  seedClaudeCode();
  seedCopilot();
});
afterAll(() => clearSeeds());

describe('claudecode: 5.5 models', () => {
  test('both spellings resolve to the same spec, as Anthropic lists it', () => {
    for (const [hyphen, dot, name, maxOut] of [
      ['claude-sonnet-5-5', 'claude-sonnet-5.5', 'Claude Sonnet 5.5', 128_000],
      ['claude-haiku-5-5', 'claude-haiku-5.5', 'Claude Haiku 5.5', 128_000],
    ] as const) {
      const spec = claudeCodeModelRegistry.getSpec(hyphen);
      expect(spec).not.toBeNull();
      expect(claudeCodeModelRegistry.getSpec(dot)).toEqual(spec);
      expect(spec!.displayName).toBe(name);
      expect(spec!.upstreamModelId).toBe(hyphen);
      expect(spec!.maxOutputTokens).toBe(maxOut);
      expect(claudeCodeModelRegistry.listModelIds()).toContain(hyphen);
    }
  });

  test('both refuse sampling parameters, in either spelling', () => {
    for (const id of ['claude-sonnet-5-5', 'claude-sonnet-5.5', 'claude-haiku-5-5', 'claude-haiku-5.5']) {
      expect(deprecatesSamplingParams(id)).toBe(true);
    }
  });
});

describe('copilot: 5.5 models', () => {
  test('both are listed and route to the same upstream id, with the output limit Copilot states', () => {
    for (const [id, maxOut] of [['claude-sonnet-5.5', 128000], ['claude-haiku-5.5', 100000]] as const) {
      const spec = copilotModelRegistry.getSpec(id);
      expect(copilotModelRegistry.listModelIds()).toContain(id);
      expect(spec?.upstreamModelId).toBe(id);
      expect(spec?.maxOutputTokens).toBe(maxOut);
      expect(spec?.timeoutMs).toBe(60000);
    }
  });
});
