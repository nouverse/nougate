/**
 * Gemini's prompt cache on the Anthropic wire: `/anthropic/v1/messages` translated for Cloud Code.
 *
 * Nouride measured this route at 1 % of input cached, against 94 % for the same model on the OpenAI wire
 * (TOKEN_SAVINGS §1, 2026-10-27). Either the translation sent Google a prefix that changed from one request to the
 * next, which loses the cache, or the cache worked and its report never reached the client. The first describe holds
 * the translation to a byte-identical prefix across two requests of one conversation; the second holds the report to
 * the place an Anthropic client reads it.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { loadProxyConfig } from '@/config/manager';
import { promptTokens } from '@/core/usage-cache';
import { buildSessionId } from '@/protocols/openai/handler';
import { antigravityModelRegistry } from '@/providers/antigravity/config/model-specs';
import { mapAnthropicToGoogle } from '@/providers/antigravity/mappers/anthropic-in';
import { createAnthropicStreamTransformer } from '@/providers/antigravity/mappers/anthropic-out';
import { clearSeeds, seedAntigravity } from './fixtures/upstream-models';

beforeAll(async () => {
  // The mapper reads the Caveman switch from the global config.
  await loadProxyConfig();
  // The model as Google's list gave it: a provider's models are its upstream's.
  seedAntigravity();
});

afterAll(() => clearSeeds());

const EPHEMERAL = { type: 'ephemeral' } as const;

/**
 * Two requests of one conversation, shaped as Nouride sends them on this wire (`packages/llm/src/anthropic.ts`): three
 * cached system tiers and the runtime block after them, a breakpoint on the newest block, and the turn's work notes
 * said once, after it. The second request is the first with one more exchange.
 */
const system = [
  { type: 'text', text: `You are Nouva.\n${'What the pack says. '.repeat(200)}`, cache_control: EPHEMERAL },
  { type: 'text', text: `How to use your tools.\n${'What the harness says. '.repeat(150)}`, cache_control: EPHEMERAL },
  { type: 'text', text: 'What you remember about this chat.', cache_control: EPHEMERAL },
  { type: 'text', text: 'Today is 2026-11-04.' },
];

const tools = [
  {
    name: 'exec',
    description: 'Run a command.',
    input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  },
  {
    name: 'read',
    description: 'Read a file.',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
];

const ask = { role: 'user', content: [{ type: 'text', text: 'How full is the disk?' }] };
const askedDisk = {
  role: 'assistant',
  content: [{ type: 'tool_use', id: 'call_df', name: 'exec', input: { command: 'df -h /' } }],
};
const disk = { type: 'tool_result', tool_use_id: 'call_df', content: '/dev/sda1  40G  12G  28G  30% /' };
const askedInodes = {
  role: 'assistant',
  content: [
    { type: 'text', text: 'And the inodes.' },
    { type: 'tool_use', id: 'call_di', name: 'exec', input: { command: 'df -i /' } },
  ],
};
const inodes = { type: 'tool_result', tool_use_id: 'call_di', content: '/dev/sda1  2.6M  300K  2.3M  12% /' };

function request(messages: unknown[]) {
  return {
    model: 'antigravity:gemini-3.8-flash-medium',
    max_tokens: 4096,
    stream: true,
    system,
    tools,
    metadata: { user_id: 'nouva:telegram:1' },
    messages,
  };
}

const first = request([
  ask,
  askedDisk,
  { role: 'user', content: [{ ...disk, cache_control: EPHEMERAL }, { type: 'text', text: 'Work notes: step 1 of 3.' }] },
]);

const second = request([
  ask,
  askedDisk,
  { role: 'user', content: [disk] },
  askedInodes,
  { role: 'user', content: [{ ...inodes, cache_control: EPHEMERAL }, { type: 'text', text: 'Work notes: step 2 of 3.' }] },
]);

/** Through the mapper as the provider calls it: the real model spec, the session id the router derives. */
function translate(body: ReturnType<typeof request>) {
  const spec = antigravityModelRegistry.getSpec('gemini-3.8-flash-medium');
  if (!spec) throw new Error('gemini-3.8-flash-medium is not in the registry');
  return mapAnthropicToGoogle(body as any, spec, buildSessionId(body, 'nouride'), {
    systemInstructionPrefix: 'You are a coding agent.',
    features: { sanitizeToolNames: true, keepThinking: false },
  });
}

/**
 * What Gemini reads, in the order it reads it — the system instruction, the tools, then every part of every turn — one
 * string per part. A cached prefix is a prefix of this list.
 */
function rendered(payload: any): string[] {
  const { systemInstruction, tools: declared, contents } = payload.request;
  return [
    JSON.stringify(systemInstruction),
    JSON.stringify(declared),
    ...contents.flatMap((content: any, index: number) =>
      content.parts.map((part: any) => `${index}:${content.role}:${JSON.stringify(part)}`),
    ),
  ];
}

describe('the translation keeps the prefix Google caches', () => {
  test('the next request begins with everything this one carried over, byte for byte', () => {
    const before = rendered(translate(first));
    const after = rendered(translate(second));

    // The work notes are the one part not carried over: Nouride says them once, after its breakpoint.
    const carried = before.slice(0, -1);
    expect(before.at(-1)).toContain('Work notes: step 1 of 3.');
    expect(after.slice(0, carried.length)).toEqual(carried);
    expect(after.length).toBeGreaterThan(carried.length);
  });

  test('and nothing around the prompt moves: config, safety, tools, session', () => {
    const { contents: _before, ...aroundBefore } = translate(first).request;
    const { contents: _after, ...aroundAfter } = translate(second).request;

    expect(JSON.stringify(aroundAfter)).toBe(JSON.stringify(aroundBefore));
  });
});

const encoder = new TextEncoder();

/**
 * A Cloud Code stream through the Anthropic transformer, as the parsed events a client receives. `unterminated` leaves
 * the last event without its blank line, so it is read in `flush` rather than `transform`.
 */
async function anthropicEvents(googleEvents: unknown[], unterminated = false): Promise<any[]> {
  const lines = googleEvents.map((event) => `data: ${JSON.stringify(event)}\n\n`);
  if (unterminated && lines.length > 0) lines[lines.length - 1] = lines[lines.length - 1]!.trimEnd();
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line));
      controller.close();
    },
  });
  const sse = await new Response(
    source.pipeThrough(createAnthropicStreamTransformer('gemini-3.8-flash', 'msg_1') as any),
  ).text();
  return sse
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)));
}

describe('the cache read reaches the client where an Anthropic client reads it', () => {
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

  test('message_start carries the prompt, split as Anthropic splits it', async () => {
    const events = await anthropicEvents(answer);

    expect(events[0].type).toBe('message_start');
    expect(events[0].message.usage).toEqual({ input_tokens: 2_000, cache_read_input_tokens: 8_000, output_tokens: 0 });
    expect(promptTokens(events[0].message.usage)).toBe(10_000);
  });

  test('so does an answer that arrives as one unterminated event', async () => {
    const events = await anthropicEvents([answer[1]], true);

    expect(events[0].type).toBe('message_start');
    expect(events[0].message.usage).toEqual({ input_tokens: 2_000, cache_read_input_tokens: 8_000, output_tokens: 0 });
    expect(events.at(-1).type).toBe('message_stop');
  });

  test('message_delta closes with the same input and the output', async () => {
    const events = await anthropicEvents(answer);
    const delta = events.find((event) => event.type === 'message_delta');

    expect(delta.usage).toEqual({ input_tokens: 2_000, cache_read_input_tokens: 8_000, output_tokens: 50 });
  });

  test('message_start still comes first, before any block', async () => {
    const events = await anthropicEvents(answer);

    expect(events.map((event) => event.type)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
  });

  test('a first event that counts nothing leaves the input at zero, as before', async () => {
    const events = await anthropicEvents([
      { response: { candidates: [{ content: { role: 'model', parts: [{ text: 'hi' }] }, finishReason: 'STOP' }] } },
    ]);

    expect(events[0].type).toBe('message_start');
    expect(events[0].message.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  test('a stream that ends before any event still opens and closes the message', async () => {
    const events = await anthropicEvents([]);

    expect(events.map((event) => event.type)).toEqual(['message_start', 'message_stop']);
  });
});
