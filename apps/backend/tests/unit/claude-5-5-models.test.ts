/**
 * Claude Sonnet 5.5 and Haiku 5.5 across the providers that serve them.
 *
 * Each provider spells the id its own way — Claude Code uses the API's hyphenated form,
 * Copilot the dotted one — and a client may send either, so both spellings are asserted here.
 */

import { describe, expect, test } from 'bun:test';
import { claudeCodeModelRegistry, deprecatesSamplingParams } from '@/providers/claudecode/config/model-specs';
import { copilotModelRegistry } from '@/providers/copilot/config/model-specs';

describe('claudecode: 5.5 models', () => {
  test('both spellings resolve to the same spec, priced at the published rate', () => {
    // Anthropic list prices, checked 2026-10-14. Haiku's is the <=100K-prompt tier.
    for (const [hyphen, dot, name, maxOut, input, output] of [
      ['claude-sonnet-5-5', 'claude-sonnet-5.5', 'Claude Sonnet 5.5', 128_000, 2, 10],
      ['claude-haiku-5-5', 'claude-haiku-5.5', 'Claude Haiku 5.5', 128_000, 0.1, 0.5],
    ] as const) {
      const spec = claudeCodeModelRegistry.getSpec(hyphen);
      expect(spec).not.toBeNull();
      expect(claudeCodeModelRegistry.getSpec(dot)).toEqual(spec);
      expect(spec!.displayName).toBe(name);
      expect(spec!.upstreamModelId).toBe(hyphen);
      expect(spec!.maxOutputTokens).toBe(maxOut);
      expect(spec!.inputPricePer1M).toBe(input);
      expect(spec!.outputPricePer1M).toBe(output);
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
  test('both are listed and route to the same upstream id', () => {
    for (const id of ['claude-sonnet-5.5', 'claude-haiku-5.5']) {
      const spec = copilotModelRegistry.getSpec(id);
      expect(spec?.upstreamModelId).toBe(id);
      expect(spec?.maxOutputTokens).toBe(8192);
      expect(spec?.timeoutMs).toBe(60000);
    }
  });
});
