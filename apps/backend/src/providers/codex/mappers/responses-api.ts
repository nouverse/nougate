/**
 * Responses API format helpers for Codex.
 *
 * Handles normalization of Responses API input format.
 * The full Responses → Chat Completions converter lives in 9router's translator;
 * here we only need the Codex-specific normalizers since Codex speaks Responses natively.
 */

/**
 * Normalize Responses API input to array format.
 * Accepts string or array, returns array of message items.
 */
export function normalizeResponsesInput(input: any): any[] | null {
  if (typeof input === 'string') {
    const text = input.trim() === '' ? '...' : input;
    return [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }];
  }
  if (Array.isArray(input)) {
    if (input.length === 0) {
      return [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '...' }] }];
    }
    return input;
  }
  return null;
}

/** Max call_id length that Responses API accepts. */
export const MAX_RESPONSES_CALL_ID_LEN = 64;

let responsesCallIdSeq = 0;

export function clampResponsesCallId(id: any): string {
  if (typeof id !== 'string' || !id) return `call_${Date.now()}_${(responsesCallIdSeq += 1)}`;
  return id.length > MAX_RESPONSES_CALL_ID_LEN ? id.substring(0, MAX_RESPONSES_CALL_ID_LEN) : id;
}

/** Single-stringify: objects → JSON once; valid JSON strings pass through. */
export function coerceResponsesArguments(value: any): string {
  if (value === undefined || value === null || value === '') return '{}';
  if (typeof value !== 'string') {
    try { return JSON.stringify(value); } catch { return '{}'; }
  }
  try { JSON.parse(value); return value; } catch { return '{}'; }
}

/** function_call_output.output must be a string — never null/object. */
export function coerceResponsesOutput(value: any): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) {
    return value.map((c: any) => {
      try { return c?.text ?? JSON.stringify(c); } catch { return String(c); }
    }).join('');
  }
  try { return JSON.stringify(value); } catch { return String(value); }
}
