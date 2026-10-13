/**
 * Cached tokens, counted once on the way to an Anthropic-shaped client.
 *
 * The bug these pin: every mapper that turns a total-prompt upstream (OpenAI, Gemini / Cloud Code)
 * into an Anthropic response copied the total into `input_tokens` and then put the cached count in
 * `cache_read_input_tokens` beside it. Anthropic's `input_tokens` *excludes* the cache, so the hit
 * was counted twice — and `promptTokens`, on the way into the metrics, added the two back together.
 * A 10,000-token prompt with 8,000 cached was logged, and priced, as 18,000.
 *
 * The non-streaming OpenAI → Anthropic path had the opposite problem: it never emitted the cached
 * count at all, so the same request reported a different cache figure depending on `stream`.
 */

import { describe, expect, test } from 'bun:test';
import {
  createOpenAIToAnthropicStreamTransformer,
  finalizeOpenAIToAnthropicResponse,
} from '@/core/mappers/anthropic-to-openai';
import {
  aggregateAnthropicResponse,
  createAnthropicStreamTransformer,
} from '@/providers/antigravity/mappers/anthropic-out';
import { anthropicUsageFromTotal, promptTokens } from '@/core/usage-cache';

const encoder = new TextEncoder();
const chunk = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;

function streamOf(lines: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line));
      controller.close();
    },
  });
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  return await new Response(stream).text();
}

function messageDeltaUsage(sse: string): any {
  const line = sse
    .split('\n')
    .find((l) => l.startsWith('data: ') && l.includes('"type":"message_delta"'));
  return line ? JSON.parse(line.slice(6)).usage : null;
}

describe('anthropicUsageFromTotal', () => {
  test('splits a total into the uncached remainder and the cache read', () => {
    expect(anthropicUsageFromTotal(10_000, 8_000)).toEqual({
      input_tokens: 2_000,
      cache_read_input_tokens: 8_000,
    });
  });

  test('round-trips through promptTokens to the original total', () => {
    // The metrics read the emitted block back with `promptTokens`; it must recover the total.
    expect(promptTokens(anthropicUsageFromTotal(10_000, 8_000))).toBe(10_000);
    expect(promptTokens(anthropicUsageFromTotal(10_000, 0))).toBe(10_000);
    expect(promptTokens(anthropicUsageFromTotal(10_000, undefined))).toBe(10_000);
  });

  test('silence about the cache leaves the total alone and the field off', () => {
    expect(anthropicUsageFromTotal(1_234, undefined)).toEqual({ input_tokens: 1_234 });
  });

  test('never goes negative when the upstream rounds the two fields differently', () => {
    expect(anthropicUsageFromTotal(100, 120)).toEqual({ input_tokens: 0, cache_read_input_tokens: 120 });
  });
});

describe('OpenAI upstream → Anthropic client', () => {
  const usage = { prompt_tokens: 10_000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 8_000 } };

  test('streaming: input_tokens excludes the cache read', async () => {
    const sse = await drain(
      streamOf([
        chunk({ choices: [{ delta: { content: 'hi' }, finish_reason: null }] }),
        chunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
        chunk({ choices: [], usage }),
        'data: [DONE]\n\n',
      ]).pipeThrough(createOpenAIToAnthropicStreamTransformer('claude-x', 'msg_1') as any),
    );

    const out = messageDeltaUsage(sse);
    expect(out).toEqual({ input_tokens: 2_000, output_tokens: 50, cache_read_input_tokens: 8_000 });
    expect(promptTokens(out)).toBe(10_000);
  });

  test('non-streaming: the cache read is emitted, and not double-counted', async () => {
    const upstream = new Response(
      JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }], usage }),
    );
    const body = await (await finalizeOpenAIToAnthropicResponse(upstream, 'claude-x', 'msg_1')).json();

    expect(body.usage).toEqual({ input_tokens: 2_000, output_tokens: 50, cache_read_input_tokens: 8_000 });
    expect(promptTokens(body.usage)).toBe(10_000);
  });

  test('streaming and non-streaming agree', async () => {
    const sse = await drain(
      streamOf([
        chunk({ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] }),
        chunk({ choices: [], usage }),
      ]).pipeThrough(createOpenAIToAnthropicStreamTransformer('claude-x', 'msg_1') as any),
    );
    const upstream = new Response(
      JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }], usage }),
    );
    const body = await (await finalizeOpenAIToAnthropicResponse(upstream, 'claude-x', 'msg_1')).json();

    expect(messageDeltaUsage(sse)).toEqual(body.usage);
  });
});

describe('Gemini / Cloud Code upstream → Anthropic client', () => {
  const usageMetadata = { promptTokenCount: 10_000, candidatesTokenCount: 50, cachedContentTokenCount: 8_000 };
  const final = chunk({
    response: {
      candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }],
      usageMetadata,
    },
  });

  test('streaming: input_tokens excludes cachedContentTokenCount', async () => {
    const sse = await drain(
      streamOf([final]).pipeThrough(createAnthropicStreamTransformer('claude-x', 'msg_1') as any),
    );

    const out = messageDeltaUsage(sse);
    expect(out).toEqual({ input_tokens: 2_000, output_tokens: 50, cache_read_input_tokens: 8_000 });
    expect(promptTokens(out)).toBe(10_000);
  });

  test('streaming, final chunk without a trailing newline (flush path)', async () => {
    const sse = await drain(
      streamOf([final.trimEnd()]).pipeThrough(createAnthropicStreamTransformer('claude-x', 'msg_1') as any),
    );

    expect(messageDeltaUsage(sse)).toEqual({ input_tokens: 2_000, output_tokens: 50, cache_read_input_tokens: 8_000 });
  });

  test('non-streaming aggregate: input_tokens excludes cachedContentTokenCount', async () => {
    const body = await aggregateAnthropicResponse(new Response(streamOf([final])), 'claude-x', 'msg_1');

    expect(body.usage).toEqual({ input_tokens: 2_000, output_tokens: 50, cache_read_input_tokens: 8_000 });
    expect(promptTokens(body.usage)).toBe(10_000);
  });

  test('no cache figure from the upstream: total passes through unchanged', async () => {
    const plain = chunk({
      response: {
        candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 1_234, candidatesTokenCount: 5 },
      },
    });
    const body = await aggregateAnthropicResponse(new Response(streamOf([plain])), 'claude-x', 'msg_1');

    expect(body.usage).toEqual({ input_tokens: 1_234, output_tokens: 5 });
  });
});
