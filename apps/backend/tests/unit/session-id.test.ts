/**
 * The request's session id names its conversation, the same on each of its requests (`buildSessionId`).
 *
 * The account a conversation is kept on (`conversation-accounts.test.ts`) is keyed by it. Hashed from the whole first
 * message, it changed between a conversation's first and second request: at the first, the first message is also the
 * newest, and carries what a client adds to its newest message (Nouride's work notes) and the cache marker. Seen live
 * on 2026-11-05: two requests in a row with two ids, the second reading the first's cache.
 */

import { describe, expect, test } from 'bun:test';
import { buildSessionId } from '@/protocols/openai/handler';

const EPHEMERAL = { type: 'ephemeral' };
const ask = { type: 'text', text: 'How full is the disk?' };
const notes = (step: number) => ({ type: 'text', text: `Work notes: step ${step}.` });
const call = (id: string) => ({ role: 'assistant', content: [{ type: 'tool_use', id, name: 'exec', input: { command: 'df -h /' } }] });
const result = (id: string) => ({ type: 'tool_result', tool_use_id: id, content: '30% used' });

/** One request of a conversation on the Anthropic wire as Nouride sends it: its name for the conversation, and its messages. */
function anthropic(messages: unknown[], userId = 'nouva:telegram:1') {
  return { model: 'claudecode:claude-sonnet-5-5', max_tokens: 1024, metadata: { user_id: userId }, messages };
}

describe('one conversation, one session id', () => {
  test('on the Anthropic wire from its first request on, whatever is added to its newest message', () => {
    const first = anthropic([{ role: 'user', content: [{ ...ask, cache_control: EPHEMERAL }, notes(1)] }]);
    const second = anthropic([
      { role: 'user', content: [{ ...ask, cache_control: EPHEMERAL }] },
      call('a'),
      { role: 'user', content: [{ ...result('a'), cache_control: EPHEMERAL }, notes(2)] },
    ]);
    const third = anthropic([
      { role: 'user', content: [ask] },
      call('a'),
      { role: 'user', content: [result('a')] },
      call('b'),
      { role: 'user', content: [{ ...result('b'), cache_control: EPHEMERAL }, notes(3)] },
    ]);

    const ids = [first, second, third].map((body) => buildSessionId(body, 'nouride'));
    expect(new Set(ids).size).toBe(1);
  });

  test('on the OpenAI wire, where the first message is the system prompt', () => {
    const body = (messages: unknown[]) => ({
      model: 'claudecode:claude-sonnet-5-5',
      user: 'nouva:telegram:1',
      messages: [{ role: 'system', content: 'You are Nouva.' }, ...messages],
    });

    expect(buildSessionId(body([{ role: 'user', content: 'How full is the disk?' }]), 'nouride')).toBe(
      buildSessionId(
        body([
          { role: 'user', content: 'How full is the disk?' },
          { role: 'assistant', content: '30% used.' },
          { role: 'user', content: 'And the inodes?' },
        ]),
        'nouride',
      ),
    );
  });
});

describe('two conversations, two ids', () => {
  test('a different opening, or the same opening in another conversation the client names, or from another client', () => {
    const one = buildSessionId(anthropic([{ role: 'user', content: [ask] }]), 'nouride');

    expect(buildSessionId(anthropic([{ role: 'user', content: [{ type: 'text', text: 'What time is it?' }] }]), 'nouride')).not.toBe(one);
    expect(buildSessionId(anthropic([{ role: 'user', content: [ask] }], 'nouva:telegram:2'), 'nouride')).not.toBe(one);
    // Named by neither wire's field, the client it came from tells them apart.
    const unnamed = { messages: [{ role: 'user', content: [ask] }] };
    expect(buildSessionId(unnamed, 'nouride/nix')).not.toBe(buildSessionId(unnamed, 'nouride/nouva'));
  });

  test('a request with no first message names no conversation: an id of its own each time', () => {
    expect(buildSessionId({ messages: [] }, 'nouride')).not.toBe(buildSessionId({ messages: [] }, 'nouride'));
  });
});
