/**
 * SSE stream helpers for Codex Responses API.
 *
 * One job: read the first stretch of a 200 OK body and decide whether it is really an error.
 * Codex reports "server is overloaded" and "model at capacity" *inside* a successful stream, so a
 * status check alone hands the caller a response that fails several kilobytes later.
 */

// SSE error patterns inside 200-OK bodies
const SSE_RETRY_PATTERNS = ['server_is_overloaded', 'service_unavailable_error'];
const SSE_ACCOUNT_FALLBACK_PATTERNS = ['selected model is at capacity', 'model_at_capacity'];
const SSE_USER_OUTPUT_PATTERNS = [
  'event: response.output_text.delta',
  'event: response.function_call_arguments.delta',
  '"type":"response.output_text.delta"',
  '"type":"response.function_call_arguments.delta"',
];

/** How many bytes to peek before deciding the stream is clean. */
const SSE_PEEK_BYTES = 256 * 1024;

export const MODEL_CAPACITY_MESSAGE = 'Selected model is at capacity. Please try a different model.';

/**
 * Search nested objects for a `message` string.
 * Used to extract error messages from SSE data events.
 */
function findNestedMessage(value: any, depth = 0): string | null {
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
function extractSseErrorMessage(text: string | null | undefined, fallback: string): string {
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

/** A failure Codex named in its stream — `response.failed`, or an `error` event — with its code where it gave one. */
export interface StreamFailure {
  message: string;
  code?: string;
}

/**
 * The failure a `response.failed` or `error` event names, from the stream's text; null when there is none.
 *
 * Codex reports a request it will not finish — a window exceeded, a usage limit, a prompt it flags — as a 200 whose
 * stream ends in one of these, never as an error status.
 */
export function streamFailure(text: string): StreamFailure | null {
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    let event: any;
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }
    const failure = failureOf(event);
    if (failure) return failure;
  }
  return null;
}

/** One parsed event's failure, or null when the event is not one. */
export function failureOf(event: any): StreamFailure | null {
  if (event?.type !== 'response.failed' && event?.type !== 'error') return null;
  const error = event.response?.error ?? event.error ?? event;
  const message = typeof error?.message === 'string' && error.message.trim() ? error.message : 'the upstream stream failed';
  const code = typeof error?.code === 'string' ? error.code : typeof error?.type === 'string' && error.type !== 'error' ? error.type : undefined;
  return code ? { message, code } : { message };
}

/**
 * How a failure Codex named in its stream is answered: the status and code its twin over HTTP would carry, so a client
 * reads a window exceeded as that, a usage limit as a rate limit, and the rest as the upstream's failure.
 */
export function streamFailureAnswer(code: string | undefined): { status: number; clientCode: string; type: string } {
  switch (code) {
    case 'context_length_exceeded':
    case 'invalid_prompt':
      return { status: 400, clientCode: code, type: 'invalid_request_error' };
    case 'insufficient_quota':
    case 'usage_not_included':
      return { status: 402, clientCode: code, type: 'insufficient_quota' };
    case 'rate_limit_exceeded':
    case 'usage_limit_reached':
      return { status: 429, clientCode: 'rate_limited', type: 'rate_limit_error' };
    default:
      return { status: 502, clientCode: code ?? 'upstream_error', type: 'server_error' };
  }
}

export interface PeekResult {
  matched: string | null;
  message: string | null;
  accountFallback: boolean;
  replacementBody: ReadableStream<Uint8Array> | null;
  /** The stream failed before it said anything (`streamFailure`): answered as an error, never as an empty reply. */
  failure?: StreamFailure;
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
  let answering = false;

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
      if (SSE_USER_OUTPUT_PATTERNS.some((p) => lowerText.includes(p))) { answering = true; break; }
    }
  } catch {
    // peek read error — continue with what we have
  }

  if (matched) {
    try { await reader.cancel(); } catch { /* noop */ }
    try { reader.releaseLock(); } catch { /* noop */ }
    return { matched, message: extractSseErrorMessage(text, matched), accountFallback, replacementBody: null };
  }

  // Failed before a word of the answer: an error the caller can still answer with a status. Passed on, the stream
  // became an empty reply with `finish_reason: stop` — a person told "I did not manage to produce an answer" on every
  // message, the reason nowhere (nouride-releases#14).
  const failure = answering ? null : streamFailure(text);
  if (failure) {
    try { await reader.cancel(); } catch { /* noop */ }
    try { reader.releaseLock(); } catch { /* noop */ }
    return { matched: null, message: failure.message, accountFallback: false, replacementBody: null, failure };
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
