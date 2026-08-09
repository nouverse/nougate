/**
 * The Google Cloud Code endpoints this provider talks to.
 *
 * Deliberately code, not config. These are not a preference — they are the
 * hosts that speak the exact wire format the mappers in
 * `providers/antigravity/mappers/` produce, in the order the retry logic in
 * `selectGoogleUrl` expects. Editing them from the dashboard could only ever
 * break a working gateway: a typo, a reordered list, or an emptied array all
 * fail at request time, on a screen that gives no way to tell you so.
 *
 * A different upstream that happens to be OpenAI- or Anthropic-shaped belongs in
 * a custom provider, which exists precisely so a URL can be set from the UI.
 */
export interface AntigravityEndpoints {
  sandbox: string[];
  cli: string[];
}

export const ANTIGRAVITY_ENDPOINTS: AntigravityEndpoints = {
  // Ordered by attempt: the first entry serves attempt 1, and a request that
  // keeps failing walks down the list.
  sandbox: [
    'https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse',
    'https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse',
    'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse',
  ],
  cli: [
    'https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse',
    'https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse',
  ],
};
