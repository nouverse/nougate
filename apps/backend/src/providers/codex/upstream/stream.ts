/**
 * SSE stream helpers for Codex Responses API.
 *
 * Handles: terminal event detection, abort payload synthesis, SSE peek for transient errors.
 */

// Responses API events that signal the stream has reached a terminal state
const OPENAI_RESPONSES_TERMINAL_EVENTS = new Set([
  'response.completed',
  'response.done',
  'response.failed',
  'error',
]);

export function isTerminalEvent(eventName: string | null, chunk?: any): boolean {
  if (eventName && OPENAI_RESPONSES_TERMINAL_EVENTS.has(eventName)) return true;
  const status = chunk?.response?.status;
  return status === 'completed' || status === 'failed';
}

const sharedEncoder = new TextEncoder();

/** Synthesize a response.failed event for streams that close without a terminal event. */
export function buildAbortedTerminalBytes(): Uint8Array {
  const failedEvent = `event: response.failed\ndata: ${JSON.stringify({
    type: 'response.failed',
    response: {
      id: `resp_${Date.now()}`,
      status: 'failed',
      error: {
        type: 'stream_error',
        code: 'stream_disconnected',
        message: 'stream closed before response.completed',
      },
    },
  })}\n\ndata: [DONE]\n\n`;
  return sharedEncoder.encode(failedEvent);
}

// SSE error patterns inside 200-OK bodies
export const SSE_RETRY_PATTERNS = ['server_is_overloaded', 'service_unavailable_error'];
export const SSE_ACCOUNT_FALLBACK_PATTERNS = ['selected model is at capacity', 'model_at_capacity'];
export const SSE_USER_OUTPUT_PATTERNS = [
  'event: response.output_text.delta',
  'event: response.function_call_arguments.delta',
  '"type":"response.output_text.delta"',
  '"type":"response.function_call_arguments.delta"',
];

/** How many bytes to peek before deciding the stream is clean. */
export const SSE_PEEK_BYTES = 256 * 1024;

export const MODEL_CAPACITY_MESSAGE = 'Selected model is at capacity. Please try a different model.';

/**
 * Search nested objects for a `message` string.
 * Used to extract error messages from SSE data events.
 */
export function findNestedMessage(value: any, depth = 0): string | null {
  if (!value || depth > 6 || typeof value === 'string') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNestedMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  if (typeof value.message === 'string' && value.message.trim()) return value.message;
  if (typeof value.error?.message === 'string' && value.error.message.trim()) return value.error.message;
  if (typeof value.response?.error?.message === 'string' && value.response.error.message.trim()) return value.response.error.message;
  for (const child of Object.values(value)) {
    const found = findNestedMessage(child, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * Extract a human-readable error message from SSE text.
 */
export function extractSseErrorMessage(text: string | null | undefined, fallback: string): string {
  const exact = text?.match(/Selected model is at capacity\. Please try a different model\./i)?.[0];
  if (exact) return exact;

  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try {
      const message = findNestedMessage(JSON.parse(data));
      if (message) return message;
    } catch {
      // Ignore non-JSON SSE data lines.
    }
  }

  return fallback || MODEL_CAPACITY_MESSAGE;
}

export interface PeekResult {
  matched: string | null;
  message: string | null;
  accountFallback: boolean;
  replacementBody: ReadableStream<Uint8Array> | null;
}

/**
 * Peek first N bytes of SSE body to detect upstream transient errors.
 *
 * Returns { matched, message, accountFallback, replacementBody }.
 * Caller must use replacementBody when no error matched (original body has been partially read).
 */
export async function peekSseTransientError(response: Response): Promise<PeekResult> {
  if (!response || !response.ok || !response.body) {
    return { matched: null, message: null, accountFallback: false, replacementBody: null };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: Uint8Array[] = [];
  let text = '';
  let matched: string | null = null;
  let accountFallback = false;

  try {
    while (text.length < SSE_PEEK_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      text += decoder.decode(value, { stream: true });

      const lowerText = text.toLowerCase();
      const accountHit = SSE_ACCOUNT_FALLBACK_PATTERNS.find((p) => lowerText.includes(p));
      if (accountHit) { matched = accountHit; accountFallback = true; break; }
      const retryHit = SSE_RETRY_PATTERNS.find((p) => lowerText.includes(p));
      if (retryHit) { matched = retryHit; break; }
      if (SSE_USER_OUTPUT_PATTERNS.some((p) => lowerText.includes(p))) break;
    }
  } catch {
    // peek read error — continue with what we have
  }

  if (matched) {
    try { await reader.cancel(); } catch { /* noop */ }
    try { reader.releaseLock(); } catch { /* noop */ }
    return { matched, message: extractSseErrorMessage(text, matched), accountFallback, replacementBody: null };
  }

  reader.releaseLock();

  // Re-assemble stream: prefix chunks + remaining upstream body
  const upstream = response.body;
  let upstreamReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const replacementBody = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      upstreamReader = upstream.getReader();
    },
    async pull(controller) {
      try {
        const { done, value } = await upstreamReader!.read();
        if (done) { controller.close(); return; }
        controller.enqueue(value);
      } catch (e) { controller.error(e); }
    },
    cancel(reason) {
      try { upstreamReader?.cancel(reason); } catch { /* noop */ }
    },
  });

  return { matched: null, message: null, accountFallback: false, replacementBody };
}
