import type { IModelSpec } from '@/core/interfaces';
import { getProxyConfig } from '@/config/manager';
import { costOf, resolvePricing } from '@/core/metrics/pricing';
import { estimateTokensFromChars } from '@/core/metrics/tokenizer';
import { tokenMetricsLogger } from '@/core/metrics/logger';

export interface CompressionStats {
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
  /**
   * What each engine that ran contributed, in pipeline order. An engine that
   * ran and saved nothing appears at 0; an engine that is switched off does not
   * appear at all.
   */
  byEngine: Array<{ engine: string; tokensSaved: number }>;
}

export interface TrackingMeta {
  provider: string;
  model: string;
  protocol: 'openai' | 'anthropic';
  clientId: string;
  sessionId?: string;
  apiKeyId?: string | null;
  modelSpec: IModelSpec | null;
  /** Estimate used when the upstream never reports prompt tokens. */
  estimatedInputTokens: number;
  compression?: CompressionStats | null;
  startedAt: number;
}

interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** Characters of assistant output seen, used for the estimation fallback. */
  outputChars: number;
  reportedByUpstream: boolean;
}

/**
 * Whether metrics collection is switched on, tolerating an unloaded config.
 */
function isMetricsEnabled(): boolean {
  try {
    return getProxyConfig().metrics?.enabled !== false;
  } catch {
    return false;
  }
}

function createTotals(): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    outputChars: 0,
    reportedByUpstream: false,
  };
}

/**
 * Merge an OpenAI- or Anthropic-shaped `usage` object into the running totals.
 */
function absorbUsage(totals: UsageTotals, usage: any): void {
  if (!usage || typeof usage !== 'object') {
    return;
  }

  const input = usage.prompt_tokens ?? usage.input_tokens;
  const output = usage.completion_tokens ?? usage.output_tokens;
  const cached =
    usage.prompt_tokens_details?.cached_tokens ??
    usage.cache_read_input_tokens ??
    usage.cached_tokens;

  if (typeof input === 'number' && input > 0) {
    totals.inputTokens = input;
    totals.reportedByUpstream = true;
  }
  if (typeof output === 'number' && output > 0) {
    totals.outputTokens = output;
    totals.reportedByUpstream = true;
  }
  if (typeof cached === 'number' && cached > 0) {
    totals.cachedInputTokens = cached;
  }
}

/**
 * Collect assistant text from a streamed delta so output tokens can still be
 * estimated when a provider omits `usage` entirely.
 */
function absorbDeltaText(totals: UsageTotals, event: any): void {
  // OpenAI chunk shape
  const openaiDelta = event?.choices?.[0]?.delta;
  if (openaiDelta) {
    if (typeof openaiDelta.content === 'string') {
      totals.outputChars += openaiDelta.content.length;
    }
    if (typeof openaiDelta.reasoning_content === 'string') {
      totals.outputChars += openaiDelta.reasoning_content.length;
    }
    if (Array.isArray(openaiDelta.tool_calls)) {
      for (const call of openaiDelta.tool_calls) {
        const args = call?.function?.arguments;
        if (typeof args === 'string') {
          totals.outputChars += args.length;
        }
      }
    }
    return;
  }

  // Anthropic event shape
  if (event?.type === 'content_block_delta') {
    const delta = event.delta;
    if (typeof delta?.text === 'string') {
      totals.outputChars += delta.text.length;
    }
    if (typeof delta?.partial_json === 'string') {
      totals.outputChars += delta.partial_json.length;
    }
  }
}

/**
 * Pull usage out of a complete (non-streamed) response payload.
 */
function absorbFinalBody(totals: UsageTotals, body: any): void {
  absorbUsage(totals, body?.usage);

  if (totals.reportedByUpstream) {
    return;
  }

  // No usage block — fall back to measuring the returned content.
  const openaiMessage = body?.choices?.[0]?.message;
  if (openaiMessage) {
    if (typeof openaiMessage.content === 'string') {
      totals.outputChars += openaiMessage.content.length;
    }
    if (typeof openaiMessage.reasoning_content === 'string') {
      totals.outputChars += openaiMessage.reasoning_content.length;
    }
    for (const call of openaiMessage.tool_calls ?? []) {
      const args = call?.function?.arguments;
      if (typeof args === 'string') {
        totals.outputChars += args.length;
      }
    }
    return;
  }

  if (Array.isArray(body?.content)) {
    for (const block of body.content) {
      if (typeof block?.text === 'string') {
        totals.outputChars += block.text.length;
      }
      if (block?.input) {
        totals.outputChars += JSON.stringify(block.input).length;
      }
    }
  }
}

/**
 * Turn the accumulated totals into a persisted metrics row.
 */
function commit(totals: UsageTotals, meta: TrackingMeta, statusCode: number, streamed: boolean): void {
  const estimated = !totals.reportedByUpstream;
  const inputTokens = totals.inputTokens || meta.estimatedInputTokens;
  const outputTokens = totals.outputTokens || estimateTokensFromChars(totals.outputChars);

  const pricing = resolvePricing(meta.modelSpec);
  const billableInput = Math.max(0, inputTokens - totals.cachedInputTokens);

  // Cached input is billed at a heavy discount by every provider that reports
  // it (10% of list price is the common rate for cache reads).
  const inputCost =
    costOf(billableInput, pricing.inputPricePer1M) +
    costOf(totals.cachedInputTokens, pricing.inputPricePer1M * 0.1);
  const outputCost = costOf(outputTokens, pricing.outputPricePer1M);

  const tokensSaved = meta.compression?.tokensSaved ?? 0;
  const costSaved = costOf(tokensSaved, pricing.inputPricePer1M);

  tokenMetricsLogger.log({
    timestamp: Date.now(),
    sessionId: meta.sessionId,
    clientId: meta.clientId,
    apiKeyId: meta.apiKeyId ?? null,
    provider: meta.provider,
    model: meta.model,
    fullModelName: `${meta.provider}:${meta.model}`,
    protocol: meta.protocol,
    streamed,
    statusCode,
    durationMs: Date.now() - meta.startedAt,
    inputTokens,
    outputTokens,
    cachedInputTokens: totals.cachedInputTokens,
    tokensBeforeCompression: meta.compression?.tokensBefore ?? null,
    tokensAfterCompression: meta.compression?.tokensAfter ?? null,
    tokensSaved,
    compressionBreakdown: meta.compression?.byEngine ?? null,
    estimated,
    inputCost,
    outputCost,
    costSaved,
  });
}

/**
 * Watch an SSE body as it streams to the client, without altering the bytes.
 */
function instrumentStream(response: Response, meta: TrackingMeta): Response {
  if (!response.body) {
    return response;
  }

  const totals = createTotals();
  const decoder = new TextDecoder();
  let buffer = '';
  let committed = false;

  const finish = () => {
    if (committed) {
      return;
    }
    committed = true;
    commit(totals, meta, response.status, true);
  };

  const scanLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) {
      return;
    }

    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') {
      return;
    }

    try {
      const event = JSON.parse(payload);
      absorbUsage(totals, event.usage);
      absorbUsage(totals, event.message?.usage);
      absorbDeltaText(totals, event);
    } catch {
      // Partial or non-JSON SSE payload — ignore, the client still gets it.
    }
  };

  // `cancel` is part of the Streams spec (it fires when the client hangs up
  // mid-response) but is missing from the bundled DOM typings, so the
  // transformer is cast rather than dropping abort handling.
  const monitor = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      // Forward first so instrumentation can never add latency or corruption.
      controller.enqueue(chunk);

      try {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          scanLine(line);
        }
      } catch {
        // Never let metrics parsing break the stream.
      }
    },
    flush() {
      try {
        if (buffer.trim()) {
          scanLine(buffer);
        }
      } catch {
        // ignore
      }
      finish();
    },
    cancel() {
      finish();
    },
  } as Transformer<Uint8Array, Uint8Array>);

  return new Response(response.body.pipeThrough(monitor), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * Read a cloned copy of a JSON response off the hot path.
 */
function instrumentJson(response: Response, meta: TrackingMeta): Response {
  const totals = createTotals();
  let clone: Response;

  try {
    clone = response.clone();
  } catch {
    return response;
  }

  void clone
    .json()
    .then((body) => absorbFinalBody(totals, body))
    .catch(() => {
      // Non-JSON or error body — still record the request with estimates.
    })
    .finally(() => commit(totals, meta, response.status, false));

  return response;
}

/**
 * Wrap a provider response so its token usage and cost land in SQLite.
 * Returns the response unchanged when metrics are disabled.
 */
export function instrumentResponse(response: Response, meta: TrackingMeta): Response {
  if (!isMetricsEnabled()) {
    return response;
  }

  try {
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('text/event-stream')) {
      return instrumentStream(response, meta);
    }
    return instrumentJson(response, meta);
  } catch (error) {
    console.warn('[Metrics] Failed to instrument response:', error);
    return response;
  }
}
