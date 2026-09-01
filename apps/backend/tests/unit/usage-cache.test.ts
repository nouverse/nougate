/**
 * Prompt-cache hits, across the three vocabularies this gateway sits between.
 *
 * The bug these pin: the antigravity mappers copied Gemini's three token counts and stopped, so
 * `usageMetadata.cachedContentTokenCount` never reached anybody. `metrics/tracker.ts` had known how to
 * read a cached count and reprice it at 0.1x the whole time and never once saw one — which made every
 * cost figure the maximum rather than the bill, and made "is caching working" unanswerable.
 */

import { describe, expect, test } from 'bun:test';
import {
  anthropicCacheUsage,
  cacheReadTokens,
  openAiCacheUsage,
} from '@/core/usage-cache';

describe('cacheReadTokens reads whatever the upstream calls it', () => {
  test('Gemini, camelCase and snake_case', () => {
    expect(cacheReadTokens({ promptTokenCount: 1000, cachedContentTokenCount: 900 })).toBe(900);
    expect(cacheReadTokens({ cached_content_token_count: 12 })).toBe(12);
  });

  test('OpenAI, under prompt_tokens_details', () => {
    expect(cacheReadTokens({ prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 768 } })).toBe(768);
  });

  test('Anthropic, as cache_read_input_tokens', () => {
    expect(cacheReadTokens({ input_tokens: 1000, cache_read_input_tokens: 512 })).toBe(512);
  });

  test('a bare cached_tokens, as some OpenAI-compatible proxies emit it', () => {
    expect(cacheReadTokens({ cached_tokens: 5 })).toBe(5);
  });

  test('a reported zero is passed on, because it says the upstream is answering', () => {
    // The difference between "no hits right now" and "nobody asked" is the whole point of this file.
    expect(cacheReadTokens({ cachedContentTokenCount: 0 })).toBe(0);
  });

  test('silence is undefined, never zero', () => {
    // Collapsing these is how a field nobody maps gets read as a feature that does not work.
    expect(cacheReadTokens({ promptTokenCount: 1000, candidatesTokenCount: 10 })).toBeUndefined();
    expect(cacheReadTokens(undefined)).toBeUndefined();
    expect(cacheReadTokens(null)).toBeUndefined();
    expect(cacheReadTokens('nonsense')).toBeUndefined();
  });

  test('a cache *write* is not counted as a read', () => {
    // Anthropic bills writes at 1.25x, not 0.1x. Folding them in would discount the single most
    // expensive part of the request.
    expect(cacheReadTokens({ cache_creation_input_tokens: 4000 })).toBeUndefined();
  });

  test('junk in the field is ignored rather than propagated', () => {
    expect(cacheReadTokens({ cachedContentTokenCount: -1 })).toBeUndefined();
    expect(cacheReadTokens({ cachedContentTokenCount: Number.NaN })).toBeUndefined();
    expect(cacheReadTokens({ cachedContentTokenCount: 'lots' })).toBeUndefined();
  });
});

describe('the emit helpers leave the field off when there is nothing to say', () => {
  test('a number becomes the protocol shape', () => {
    expect(openAiCacheUsage(900)).toEqual({ prompt_tokens_details: { cached_tokens: 900 } });
    expect(anthropicCacheUsage(900)).toEqual({ cache_read_input_tokens: 900 });
  });

  test('a reported zero is still emitted', () => {
    expect(openAiCacheUsage(0)).toEqual({ prompt_tokens_details: { cached_tokens: 0 } });
    expect(anthropicCacheUsage(0)).toEqual({ cache_read_input_tokens: 0 });
  });

  test('undefined emits nothing at all, so the key is absent from the wire', () => {
    expect(openAiCacheUsage(undefined)).toEqual({});
    expect(anthropicCacheUsage(undefined)).toEqual({});
    // Spread into a usage block, an absent key is what a client sees as "not reported".
    expect({ prompt_tokens: 5, ...openAiCacheUsage(undefined) }).toEqual({ prompt_tokens: 5 });
  });
});
