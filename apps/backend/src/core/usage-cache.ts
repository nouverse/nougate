/**
 * Prompt-cache hits, read from whatever the upstream calls them and written in whatever the client
 * expects to see.
 *
 * Three vocabularies for one number, and this gateway sits between all of them:
 *
 *   - Gemini / Cloud Code → `usageMetadata.cachedContentTokenCount`
 *   - OpenAI              → `usage.prompt_tokens_details.cached_tokens`
 *   - Anthropic           → `usage.cache_read_input_tokens`
 *
 * Before this, the antigravity mappers copied `promptTokenCount`, `candidatesTokenCount` and
 * `totalTokenCount` and stopped there — so a cache hit and a full read left the proxy looking
 * identical. `metrics/tracker.ts` had known how to read and reprice hits at 0.1x the whole time and
 * never saw one, which made "is caching working" an argument instead of a query, and made every
 * dashboard cost figure the maximum rather than the bill.
 *
 * ## Why a shared helper and not four inline reads
 *
 * There are four emit sites for two protocols, and they have to agree. A cached count that appears on
 * the streaming path and not the non-streaming one is worse than one that appears nowhere: the numbers
 * move when a client flips `stream`, and nobody suspects the mapper.
 *
 * ## The distinction this file exists to keep
 *
 * `undefined` means the upstream said nothing about caching. `0` means it said there were no hits.
 * Only the second is evidence that caching is not working, and collapsing them is exactly how a
 * missing field gets read as a broken feature. So every function here returns `undefined` rather than
 * a zero it was not told, and the emit helpers leave the field off entirely.
 */

/**
 * Cache-read tokens from any usage block this gateway might see, or `undefined` if it said nothing.
 *
 * Reads all three vocabularies rather than being told which one to expect, because the same helper
 * runs on responses from a Gemini upstream, a real OpenAI upstream and a real Anthropic upstream — and
 * a custom provider can be pointed at any of them from the dashboard without touching this code.
 *
 * `cache_creation_input_tokens` is deliberately *not* included. Anthropic charges cache **writes** at
 * 1.25x, not 0.1x, so folding them in here would discount the most expensive tokens in the request.
 */
export function cacheReadTokens(usage: any): number | undefined {
  if (!usage || typeof usage !== 'object') return undefined;

  const candidates = [
    // Gemini, both spellings — the REST docs use camelCase, some transports snake_case.
    usage.cachedContentTokenCount,
    usage.cached_content_token_count,
    // OpenAI
    usage.prompt_tokens_details?.cached_tokens,
    // Anthropic
    usage.cache_read_input_tokens,
    // Bare, as some OpenAI-compatible proxies emit it
    usage.cached_tokens,
  ];

  for (const value of candidates) {
    // `>= 0` and not `> 0`: a reported zero is a fact worth passing on — it says the upstream is
    // answering the question, which is what tells you the plumbing works on a quiet cache.
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  }
  return undefined;
}

/** The OpenAI shape, or nothing to spread when the upstream said nothing. */
export function openAiCacheUsage(cached: number | undefined) {
  return typeof cached === 'number' ? { prompt_tokens_details: { cached_tokens: cached } } : {};
}

/** The Anthropic shape, or nothing to spread when the upstream said nothing. */
export function anthropicCacheUsage(cached: number | undefined) {
  return typeof cached === 'number' ? { cache_read_input_tokens: cached } : {};
}

/**
 * The whole prompt, however the upstream chose to split it.
 *
 * OpenAI and Gemini report a **total** and name the cached part as a subset of it. Anthropic does the
 * opposite: `input_tokens` is what was *not* served from cache, and the cached tokens sit beside it
 * in their own fields. Copying `input_tokens` into `prompt_tokens` therefore under-reports the prompt
 * by exactly the amount the cache saved — and produces an OpenAI usage block that is impossible under
 * OpenAI's own rules, where `cached_tokens` came out larger than the `prompt_tokens` it is supposed
 * to be part of. A client computing "uncached = prompt − cached" got a negative number, and the
 * metrics recorded a 2,830-token prompt as 6.
 *
 * `cache_creation_input_tokens` is counted here even though `cacheReadTokens` deliberately excludes
 * it: the two answer different questions. That one asks what the cache *saved*, and a write saves
 * nothing — it costs 1.25x. This asks how large the prompt *was*, and tokens written to the cache
 * were read from the prompt like any other.
 *
 * Detection is by the two Anthropic-only field names rather than by the presence of `input_tokens`,
 * which OpenAI's Responses API also uses — with OpenAI's own subset semantics.
 */
export function promptTokens(usage: any): number | undefined {
  if (!usage || typeof usage !== 'object') return undefined;

  const anthropicInput = usage.input_tokens;
  const cacheRead = usage.cache_read_input_tokens;
  const cacheWrite = usage.cache_creation_input_tokens;

  if (
    typeof anthropicInput === 'number' &&
    (typeof cacheRead === 'number' || typeof cacheWrite === 'number')
  ) {
    return anthropicInput + (cacheRead ?? 0) + (cacheWrite ?? 0);
  }

  for (const value of [usage.prompt_tokens, usage.promptTokenCount, anthropicInput]) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

/**
 * An Anthropic `usage` block built from a prompt **total** — the inverse of `promptTokens`.
 *
 * Every upstream that reaches an Anthropic-shaped client through a mapper (OpenAI, Gemini / Cloud
 * Code) reports the whole prompt and names the cached part as a subset of it. Anthropic does not:
 * `input_tokens` is only what the cache did *not* serve. Copying the total into `input_tokens` and
 * then adding `cache_read_input_tokens` beside it counted every hit twice — once at full price in
 * `input_tokens`, again in the cache field — and `promptTokens` on the way into the metrics summed
 * the two, so a 10,000-token prompt with 8,000 cached was logged and billed as 18,000.
 *
 * Clamped at zero because the total and the cached count come from different fields, and an
 * upstream that rounds them differently must not produce a negative `input_tokens`.
 */
export function anthropicUsageFromTotal(promptTotal: number, cached: number | undefined) {
  const uncached = typeof cached === 'number' ? Math.max(0, promptTotal - cached) : promptTotal;
  return { input_tokens: uncached, ...anthropicCacheUsage(cached) };
}
