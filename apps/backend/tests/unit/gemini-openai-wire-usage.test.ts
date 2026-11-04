/**
 * Gemini's usage on the OpenAI wire, `stream: false` beside `stream: true`.
 *
 * The streamed answer carries `usage` on every chunk Cloud Code counts, the cache read as
 * `prompt_tokens_details.cached_tokens`. The non-streamed one is assembled from that same stream, and kept only the
 * text, the reasoning and the tool calls: it reached the client with no `usage` at all, so a client that asks without
 * streaming — Nouride does for its side calls — had to estimate the prompt and recorded no cache read on it.
 */

import { describe, expect, test } from 'bun:test';
import { finalizeOpenAIResponse } from '@/providers/antigravity';

const encoder = new TextEncoder();

/** A Cloud Code response body: the SSE stream every Antigravity answer arrives as, streamed to the client or not. */
function cloudCode(events: unknown[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        controller.close();
      },
    }),
  );
}

// Gemini counts the whole prompt and names the cached part inside it.
const usageMetadata = { promptTokenCount: 10_000, cachedContentTokenCount: 8_000, totalTokenCount: 10_000 };
const answer = [
  { response: { candidates: [{ content: { role: 'model', parts: [{ text: 'The disk is ' }] } }], usageMetadata } },
  {
    response: {
      candidates: [{ content: { role: 'model', parts: [{ text: '30% full.' }] }, finishReason: 'STOP' }],
      usageMetadata: { ...usageMetadata, candidatesTokenCount: 50, totalTokenCount: 10_050 },
    },
  },
];

async function finalize(events: unknown[], stream: boolean) {
  const result = await finalizeOpenAIResponse({
    googleRes: cloudCode(events),
    openaiBody: { model: 'gemini-3.8-flash', stream, messages: [{ role: 'user', content: 'How full is the disk?' }] },
    requestId: 'chatcmpl-test',
    sessionId: 'session-test',
    attempts: 1,
    accountEmail: 'account@example.com',
    messageCount: 1,
    assistantTurnIndex: 0,
  });
  if (!result.response) throw new Error('the answer was sent back for a retry');
  return result.response;
}

describe('a non-streamed Gemini answer on the OpenAI wire', () => {
  test('carries the usage, the cache read included', async () => {
    const body = await (await finalize(answer, false)).json();

    expect(body.choices[0].message.content).toBe('The disk is 30% full.');
    expect(body.usage).toEqual({
      prompt_tokens: 10_000,
      completion_tokens: 50,
      total_tokens: 10_050,
      prompt_tokens_details: { cached_tokens: 8_000 },
    });
  });

  test('the same figures the streamed answer ends with', async () => {
    const streamed = await (await finalize(answer, true)).text();
    const lastUsage = streamed
      .split('\n')
      .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
      .map((line) => JSON.parse(line.slice(6)))
      .filter((chunk) => chunk.usage)
      .at(-1)?.usage;
    const body = await (await finalize(answer, false)).json();

    expect(lastUsage).toBeDefined();
    expect(body.usage).toEqual(lastUsage);
  });

  test('a usage that arrives on a chunk of its own is kept too', async () => {
    const body = await (
      await finalize(
        [
          { response: { candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }] } },
          { response: { usageMetadata: { ...usageMetadata, candidatesTokenCount: 1, totalTokenCount: 10_001 } } },
        ],
        false,
      )
    ).json();

    expect(body.usage).toEqual({
      prompt_tokens: 10_000,
      completion_tokens: 1,
      total_tokens: 10_001,
      prompt_tokens_details: { cached_tokens: 8_000 },
    });
  });

  test('an upstream that counts nothing gets no usage invented for it', async () => {
    const body = await (
      await finalize([{ response: { candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }] } }], false)
    ).json();

    expect(body.choices[0].message.content).toBe('hi');
    expect(body.usage).toBeUndefined();
  });
});
