/**
 * Sampling parameters the newer Claude models refuse outright.
 *
 * Anthropic answers `temperature`, `top_p` and `top_k` with a 400 on Opus 5, Opus 4.8, Sonnet 5 and
 * Fable 5.1 — "`temperature` is deprecated for this model" — rather than ignoring them. So an agent
 * configured with `temperature: 0.7` could not reach those models at all, while the same agent
 * worked on Sonnet 4.6. The split is per model, not per family, which is why the gateway carries a
 * list rather than a rule.
 */

import { describe, expect, test } from 'bun:test';
import { dropDeprecatedSampling } from '@/providers/claudecode/mappers/sampling';
import { deprecatesSamplingParams, claudeCodeModelRegistry } from '@/providers/claudecode/config/model-specs';

describe('which models refuse sampling parameters', () => {
  test('the split runs through both families, not along them', () => {
    // Verified against the live API on 2026-09-06. Sonnet appears on both sides, which is the whole
    // reason this cannot be derived from the model name.
    expect(deprecatesSamplingParams('claude-sonnet-5')).toBe(true);
    expect(deprecatesSamplingParams('claude-sonnet-4-6')).toBe(false);
    expect(deprecatesSamplingParams('claude-opus-5')).toBe(true);
    expect(deprecatesSamplingParams('claude-haiku-4-5')).toBe(false);
  });

  test('every listed id is a model this provider actually offers', () => {
    // A typo here would silently do nothing, and the symptom would be the 400 it was meant to stop.
    for (const modelId of claudeCodeModelRegistry.listModelIds()) {
      // Just asserting the registry resolves them; the point is the loop below.
      expect(claudeCodeModelRegistry.getSpec(modelId)).not.toBeNull();
    }
    for (const modelId of ['claude-opus-5', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-fable-5-1']) {
      expect(deprecatesSamplingParams(modelId)).toBe(true);
      expect(claudeCodeModelRegistry.getSpec(modelId)).not.toBeNull();
    }
  });
});

describe('dropDeprecatedSampling', () => {
  test('removes all three from a model that refuses them', () => {
    const body = { model: 'claude-opus-5', temperature: 0.7, top_p: 0.9, top_k: 40, max_tokens: 16 };
    const out = dropDeprecatedSampling(body, 'claude-opus-5') as Record<string, unknown>;

    expect(out).not.toHaveProperty('temperature');
    expect(out).not.toHaveProperty('top_p');
    expect(out).not.toHaveProperty('top_k');
    expect(out.max_tokens).toBe(16);
  });

  test('drops temperature: 1 as well, which the upstream would have accepted', () => {
    // Anthropic's own default, so removing it changes nothing — and one unconditional rule beats
    // three exceptions that each have to be right.
    const out = dropDeprecatedSampling({ temperature: 1 }, 'claude-opus-5') as Record<string, unknown>;
    expect(out).not.toHaveProperty('temperature');
  });

  test('leaves a model that honours them untouched, by identity', () => {
    const body = { temperature: 0.7, top_p: 0.9 };
    // Same object back: a model that accepts sampling must not have its request rebuilt at all.
    expect(dropDeprecatedSampling(body, 'claude-sonnet-4-6')).toBe(body);
  });

  test('returns the same object when there is nothing to remove', () => {
    const body = { model: 'claude-opus-5', max_tokens: 16 };
    expect(dropDeprecatedSampling(body, 'claude-opus-5')).toBe(body);
  });

  test('does not mutate the caller\'s body', () => {
    // The body is shared with the metrics and compression paths; stripping in place would remove
    // parameters from a request other code is still reading.
    const body = { temperature: 0.7, max_tokens: 16 };
    dropDeprecatedSampling(body, 'claude-opus-5');
    expect(body.temperature).toBe(0.7);
  });

  test('survives a body that is not an object', () => {
    expect(dropDeprecatedSampling(null, 'claude-opus-5')).toBeNull();
    expect(dropDeprecatedSampling('not-json', 'claude-opus-5')).toBe('not-json');
  });
});
