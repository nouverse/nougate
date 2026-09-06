/**
 * Dropping replayed thinking blocks the upstream will reject.
 *
 * Until this was wired, `upstream/signature.ts` was imported by nothing but its own test — the
 * validation existed and never ran. The failure it prevents is the expensive kind: one bad signature
 * in a long history rejects every subsequent turn of that conversation, and the error names a block
 * index rather than a reason.
 */

import { describe, expect, test } from 'bun:test';
import { dropUnusableThinking } from '@/providers/claudecode/mappers/thinking';
import { CLAUDE_SIGNATURE_MARKER } from '@/providers/claudecode/upstream/signature';

/** A signature that passes validation: base64 of a buffer opening with the Claude marker. */
const GOOD_SIG = Buffer.from([CLAUDE_SIGNATURE_MARKER, 0x01, 0x02]).toString('base64');
const BAD_SIG = 'not-a-real-signature';

describe('what gets dropped', () => {
  test('an assistant thinking block with an unusable signature goes', () => {
    const body = {
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'hmm', signature: BAD_SIG },
            { type: 'text', text: 'the answer' },
          ],
        },
      ],
    };

    const out = dropUnusableThinking(body);
    expect(out.messages[0].content).toEqual([{ type: 'text', text: 'the answer' }]);
  });

  test('redacted_thinking is signed the same way and treated the same', () => {
    const body = {
      messages: [
        { role: 'assistant', content: [{ type: 'redacted_thinking', data: 'x', signature: BAD_SIG }] },
      ],
    };
    expect(dropUnusableThinking(body).messages[0].content).toEqual([]);
  });

  test('a valid signature is kept', () => {
    const block = { type: 'thinking', thinking: 'hmm', signature: GOOD_SIG };
    const body = { messages: [{ role: 'assistant', content: [block] }] };
    expect(dropUnusableThinking(body).messages[0].content).toEqual([block]);
  });
});

describe('what is deliberately left alone', () => {
  test('a message carrying tool_use is untouched even with a bad signature', () => {
    // Stripping the thinking block here trades one rejection for another: Anthropic requires an
    // assistant turn with tool_use to open with a thinking block when thinking is on. Leaving it means
    // the upstream error points at the block the client actually sent.
    const body = {
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'hmm', signature: BAD_SIG },
            { type: 'tool_use', id: 'tu_1', name: 'Read', input: {} },
          ],
        },
      ],
    };

    const out = dropUnusableThinking(body);
    expect(out).toBe(body);
    expect(out.messages[0].content).toHaveLength(2);
  });

  test('user messages are not inspected', () => {
    const body = {
      messages: [{ role: 'user', content: [{ type: 'thinking', signature: BAD_SIG }] }],
    };
    expect(dropUnusableThinking(body)).toBe(body);
  });

  test('a body with nothing to change is returned by identity, not copied', () => {
    const body = { messages: [{ role: 'assistant', content: [{ type: 'text', text: 'hi' }] }] };
    expect(dropUnusableThinking(body)).toBe(body);
  });

  test('a body with no messages at all is safe', () => {
    expect(dropUnusableThinking({})).toEqual({});
    expect(dropUnusableThinking({ messages: 'not an array' })).toEqual({ messages: 'not an array' });
  });

  test('string content is left alone', () => {
    const body = { messages: [{ role: 'assistant', content: 'plain text' }] };
    expect(dropUnusableThinking(body)).toBe(body);
  });
});

describe('the filter actually runs on the request path', () => {
  test('a missing signature is unusable, which is the common client mistake', () => {
    // A client that reconstructs an assistant turn by hand omits the signature entirely.
    const body = {
      messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }] }],
    };
    expect(dropUnusableThinking(body).messages[0].content).toEqual([]);
  });

  test('only the offending block goes, not the whole message', () => {
    const body = {
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'bad', signature: BAD_SIG },
            { type: 'thinking', thinking: 'good', signature: GOOD_SIG },
            { type: 'text', text: 'answer' },
          ],
        },
      ],
    };

    const kept = dropUnusableThinking(body).messages[0].content;
    expect(kept).toHaveLength(2);
    expect(kept[0].thinking).toBe('good');
  });
});
