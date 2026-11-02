/**
 * A Codex tool call's arguments reach the client however Codex sends them.
 *
 * Codex streams argument deltas for a single call, and none for calls it makes in parallel: their arguments arrive only
 * when each call closes, in `response.output_item.done` (and `response.function_call_arguments.done`). The translation
 * read the deltas alone, so every parallel call reached the client as `{}` — found live on 2026-11-02, a Nouride agent
 * on `codex:gpt-5.6-luna` whose three `glob` calls in one step each failed for want of a pattern.
 */

import { describe, expect, test } from 'bun:test';
import {
  createResponsesToOpenAIStreamTransformer,
  finalizeResponsesToOpenAIResponse,
} from '@/providers/codex/mappers/openai-to-responses';

const event = (payload: Record<string, unknown>) => `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`;
const call = (n: number, args: string) => ({ type: 'function_call', id: `fc_${n}`, call_id: `call_${n}`, name: 'glob', arguments: args });
const added = (n: number, args = '') => event({ type: 'response.output_item.added', output_index: n, item: call(n, args) });
const itemDone = (n: number, args: string) => event({ type: 'response.output_item.done', output_index: n, item: call(n, args) });
const argsDelta = (n: number, delta: string) => event({ type: 'response.function_call_arguments.delta', output_index: n, item_id: `fc_${n}`, delta });
const argsDone = (n: number, args: string) => event({ type: 'response.function_call_arguments.done', output_index: n, item_id: `fc_${n}`, arguments: args });
const completed = event({ type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } });
const sse = (...parts: string[]) => new Response(parts.join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });

/** The calls a Chat Completions client assembles from the stream: by index, the first fragment's id and name, the arguments joined. */
async function callsOf(...parts: string[]): Promise<{ id: string; name: string; arguments: string }[]> {
  const out = await new Response(sse(...parts).body!.pipeThrough(createResponsesToOpenAIStreamTransformer('codex:gpt-5.6-luna'))).text();
  const calls: { id: string; name: string; arguments: string }[] = [];
  for (const line of out.split('\n')) {
    if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
    for (const fragment of JSON.parse(line.slice(6)).choices?.[0]?.delta?.tool_calls ?? []) {
      const slot = (calls[fragment.index] ??= { id: '', name: '', arguments: '' });
      slot.id ||= fragment.id ?? '';
      slot.name ||= fragment.function?.name ?? '';
      slot.arguments += fragment.function?.arguments ?? '';
    }
  }
  return calls;
}

describe("a Codex tool call's arguments", () => {
  test('parallel calls with no deltas get their arguments when each closes', async () => {
    const calls = await callsOf(added(1), added(2), added(3), itemDone(1, '{"pattern":"a/*.txt"}'), itemDone(2, '{"pattern":"b/*.txt"}'), itemDone(3, '{"pattern":"c/*.txt"}'), completed);
    expect(calls).toEqual([
      { id: 'call_1', name: 'glob', arguments: '{"pattern":"a/*.txt"}' },
      { id: 'call_2', name: 'glob', arguments: '{"pattern":"b/*.txt"}' },
      { id: 'call_3', name: 'glob', arguments: '{"pattern":"c/*.txt"}' },
    ]);
  });

  test('`function_call_arguments.done` alone carries them too', async () => {
    const calls = await callsOf(added(1), added(2), argsDone(1, '{"pattern":"a"}'), argsDone(2, '{"pattern":"b"}'), completed);
    expect(calls.map((c) => c.arguments)).toEqual(['{"pattern":"a"}', '{"pattern":"b"}']);
  });

  test('streamed arguments are not sent again at the close', async () => {
    const calls = await callsOf(added(1), argsDelta(1, '{"pattern":'), argsDelta(1, '"a"}'), argsDone(1, '{"pattern":"a"}'), itemDone(1, '{"pattern":"a"}'), completed);
    expect(calls).toEqual([{ id: 'call_1', name: 'glob', arguments: '{"pattern":"a"}' }]);
  });

  test('a call first seen at its close is sent whole', async () => {
    const calls = await callsOf(itemDone(4, '{"pattern":"d"}'), completed);
    expect(calls).toEqual([{ id: 'call_4', name: 'glob', arguments: '{"pattern":"d"}' }]);
  });

  test('without a stream to keep, the collected answer carries them as well', async () => {
    const res = await finalizeResponsesToOpenAIResponse(sse(added(1), added(2), itemDone(1, '{"pattern":"a"}'), itemDone(2, '{"pattern":"b"}'), completed), 'codex:gpt-5.6-luna');
    const message = ((await res.json()) as any).choices[0].message;
    expect(message.tool_calls.map((c: any) => c.function.arguments)).toEqual(['{"pattern":"a"}', '{"pattern":"b"}']);
  });
});
