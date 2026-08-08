/**
 * Rough token estimation used only when an upstream provider does not report
 * real usage numbers. English text averages ~4 characters per token; JSON
 * structure is denser, so payloads are estimated slightly more conservatively.
 */
const CHARS_PER_TOKEN = 4;

/**
 * Estimate the token count of a plain string.
 */
export function estimateTokens(text: string): number {
  if (!text) {
    return 0;
  }
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Estimate a token count from a character total that was accumulated
 * incrementally (e.g. while a response streamed).
 */
export function estimateTokensFromChars(chars: number): number {
  if (!chars || chars <= 0) {
    return 0;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Estimate the token count of a request/response payload.
 */
export function estimatePayloadTokens(payload: unknown): number {
  if (payload === undefined || payload === null) {
    return 0;
  }

  try {
    const serialized = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return estimateTokens(serialized ?? '');
  } catch {
    return 0;
  }
}
