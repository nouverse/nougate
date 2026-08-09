import { describe, expect, test } from 'bun:test';
import { createOpenAIToAnthropicStreamTransformer } from '@/core/mappers/anthropic-to-openai';

/**
 * OpenAI-style upstream → Anthropic client, the path every Anthropic-native
 * tool takes through a custom provider or Copilot.
 *
 * The bug: the message was finalised as soon as a `finish_reason` arrived, but
 * OpenAI sends the usage totals in a *later* chunk. The `finished` guard then
 * blocked the real numbers from ever being emitted, so clients — and our own
 * metrics, which read this same stream — saw zero input tokens on nearly every
 * request.
 */

async function run(upstreamLines: string[]): Promise<string> {
  const encoder = new TextEncoder();
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of upstreamLines) {
        controller.enqueue(encoder.encode(line));
      }
      controller.close();
    },
  });

  const out = source.pipeThrough(
    createOpenAIToAnthropicStreamTransformer('claude-opus-4.6', 'msg_test') as any,
  );

  let text = '';
  const decoder = new TextDecoder();
  const reader = (out as ReadableStream<Uint8Array>).getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

function messageDelta(sse: string): any {
  const line = sse
    .split('\n')
    .find((l) => l.startsWith('data: ') && l.includes('"type":"message_delta"'));
  return line ? JSON.parse(line.slice(6)) : null;
}

const chunk = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;

describe('usage survives the OpenAI → Anthropic translation', () => {
  test('usage arriving after finish_reason still reaches the client', async () => {
    const sse = await run([
      chunk({ choices: [{ delta: { content: 'hi' }, finish_reason: null }] }),
      chunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      // OpenAI's real ordering: totals come last, in a chunk with no choices.
      chunk({ choices: [], usage: { prompt_tokens: 1234, completion_tokens: 56 } }),
      'data: [DONE]\n\n',
    ]);

    const delta = messageDelta(sse);
    expect(delta).not.toBeNull();
    expect(delta.usage.input_tokens).toBe(1234);
    expect(delta.usage.output_tokens).toBe(56);
  });

  test('the message is closed exactly once', async () => {
    const sse = await run([
      chunk({ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] }),
      chunk({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } }),
      'data: [DONE]\n\n',
    ]);

    // A duplicate message_stop makes Anthropic clients error on the second one.
    expect(sse.split('"type":"message_stop"').length - 1).toBe(1);
    expect(sse.split('"type":"message_delta"').length - 1).toBe(1);
  });

  test('the stop reason from finish_reason is preserved', async () => {
    const sse = await run([
      chunk({ choices: [{ delta: {}, finish_reason: 'length' }] }),
      chunk({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 1 } }),
      'data: [DONE]\n\n',
    ]);

    expect(messageDelta(sse).delta.stop_reason).toBe('max_tokens');
  });

  test('tool calls end as tool_use, not end_turn', async () => {
    const sse = await run([
      chunk({
        choices: [
          { delta: { tool_calls: [{ id: 't1', function: { name: 'ls', arguments: '{}' } }] } },
        ],
      }),
      chunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      'data: [DONE]\n\n',
    ]);

    expect(messageDelta(sse).delta.stop_reason).toBe('tool_use');
  });

  test('an upstream that just stops still yields a closed message', async () => {
    // No finish_reason, no [DONE] — some OpenAI-compatible providers do this,
    // and an unclosed message leaves the client waiting until its own timeout.
    const sse = await run([chunk({ choices: [{ delta: { content: 'partial' } }] })]);

    expect(sse).toContain('"type":"message_stop"');
    expect(messageDelta(sse).delta.stop_reason).toBe('end_turn');
  });

  test('an upstream that reports no usage still closes cleanly', async () => {
    const sse = await run([
      chunk({ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] }),
      'data: [DONE]\n\n',
    ]);

    const delta = messageDelta(sse);
    // Zeros here are honest: nothing was reported. The metrics layer flags the
    // row as estimated rather than treating these as measured.
    expect(delta.usage.input_tokens).toBe(0);
    expect(delta.usage.output_tokens).toBe(0);
    expect(sse).toContain('"type":"message_stop"');
  });
});
