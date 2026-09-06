/**
 * How large the prompt was, when two upstreams disagree about what the number means.
 *
 * OpenAI and Gemini report a total and call the cached part a subset of it. Anthropic reports the
 * *remainder* and puts the cached tokens in their own fields. Copying `input_tokens` straight into
 * `prompt_tokens` therefore produced an OpenAI usage block where `cached_tokens` was larger than the
 * `prompt_tokens` it belongs to — 2,824 inside 6 — and logged a 2,830-token prompt as 6.
 *
 * Caught on a live request, not by reading: the cache only engages past Anthropic's minimum
 * cacheable length, so every short test request had reported zero and looked correct.
 */

import { describe, expect, test } from 'bun:test';
import { cacheReadTokens, promptTokens } from '@/core/usage-cache';

describe('promptTokens', () => {
  test('adds the cached tokens back for an Anthropic upstream', () => {
    // The shape that produced the bug, copied from a real response.
    const usage = {
      input_tokens: 6,
      cache_read_input_tokens: 2824,
      cache_creation_input_tokens: 0,
      output_tokens: 16,
    };

    expect(promptTokens(usage)).toBe(2830);
    // The invariant that was violated: the cached part fits inside the total.
    expect(cacheReadTokens(usage)!).toBeLessThanOrEqual(promptTokens(usage)!);
  });

  test('counts cache writes into the prompt, though they are not a saving', () => {
    // `cacheReadTokens` excludes writes on purpose — Anthropic charges them at 1.25x, so folding
    // them into "what the cache saved" would discount the most expensive tokens in the request.
    // The prompt still contained them.
    const usage = { input_tokens: 6, cache_creation_input_tokens: 2824, cache_read_input_tokens: 0 };

    expect(promptTokens(usage)).toBe(2830);
    expect(cacheReadTokens(usage)).toBe(0);
  });

  test('leaves an OpenAI total alone, because it already includes the cached part', () => {
    const usage = { prompt_tokens: 2486, prompt_tokens_details: { cached_tokens: 1792 } };
    expect(promptTokens(usage)).toBe(2486);
  });

  test('leaves the Responses API alone, which uses input_tokens with OpenAI semantics', () => {
    // Codex reports `input_tokens` too. Detection keys on the two Anthropic-only field names rather
    // than on `input_tokens`, or this would inflate every Codex prompt by its own cached tokens.
    const usage = { input_tokens: 2486, input_tokens_details: { cached_tokens: 1792 } };
    expect(promptTokens(usage)).toBe(2486);
  });

  test('leaves a Gemini total alone', () => {
    expect(promptTokens({ promptTokenCount: 20000, cachedContentTokenCount: 18000 })).toBe(20000);
  });

  test('says nothing when the upstream did', () => {
    expect(promptTokens(undefined)).toBeUndefined();
    expect(promptTokens({})).toBeUndefined();
    expect(promptTokens({ output_tokens: 5 })).toBeUndefined();
  });
});
