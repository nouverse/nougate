/**
 * Claude's prompt cache on the OpenAI wire: `/openai/v1/chat/completions` translated for the Messages API.
 *
 * Anthropic caches only where a request marks a breakpoint, and an OpenAI-shaped request has no way to mark one, so the
 * translation has to. It marked the system prompt alone: the tools and the system were read back, the conversation —
 * most of a long agent's prompt, and all of what grows — was sent at full price on every request. Nouride measured
 * Claude Sonnet 5.5 at 38 % cached on this wire against 81 % on the Anthropic one (TOKEN_SAVINGS §1, 2026-10-27).
 *
 * The tests replay what Anthropic does with two consecutive requests of one conversation: an entry is written at each
 * breakpoint, and the next request reads the longest one whose bytes it repeats, found within 20 blocks of a breakpoint
 * of its own.
 */

import { beforeAll, describe, expect, test } from 'bun:test';
import { loadProxyConfig } from '@/config/manager';
import {
  createAnthropicToOpenAIStreamTransformer,
  finalizeAnthropicToOpenAIResponse,
  mapOpenAIToAnthropic,
} from '@/core/mappers/openai-to-anthropic';

beforeAll(async () => {
  // The mapper reads the Caveman switch from the global config.
  await loadProxyConfig();
});

/** Anthropic's own limit: a fifth breakpoint is a 400, not a warning. */
const MAX_BREAKPOINTS = 4;

/** How far back from a breakpoint Anthropic looks for an entry an earlier request wrote. */
const LOOKBACK_BLOCKS = 20;

/**
 * One conversation, shaped as Nouride sends it on this wire (`packages/llm/src/openai.ts`): the system prompt flattened
 * into one message, the tools, the history, and the turn's work notes said once at the very end, in a user message the
 * next request does not repeat.
 */
const systemPrompt = [
  `You are Nouva.\n${'What the pack says. '.repeat(200)}`,
  `How to use your tools.\n${'What the harness says. '.repeat(150)}`,
  'What you remember about this chat.',
  'Today is 2026-11-04.',
].join('\n\n');

const tools = [
  {
    type: 'function',
    function: {
      name: 'exec',
      description: 'Run a command.',
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read',
      description: 'Read a file.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
];

const ask = { role: 'user', content: 'How full is the disk?' };
const askedDisk = {
  role: 'assistant',
  content: null,
  tool_calls: [{ id: 'call_df', type: 'function', function: { name: 'exec', arguments: '{"command":"df -h /"}' } }],
};
const disk = { role: 'tool', tool_call_id: 'call_df', content: '/dev/sda1  40G  12G  28G  30% /' };
const askedInodes = {
  role: 'assistant',
  content: 'And the inodes.',
  tool_calls: [{ id: 'call_di', type: 'function', function: { name: 'exec', arguments: '{"command":"df -i /"}' } }],
};
const inodes = { role: 'tool', tool_call_id: 'call_di', content: '/dev/sda1  2.6M  300K  2.3M  12% /' };
const notes = (step: number) => ({ role: 'user', content: `Work notes: step ${step} of 3.` });

/** Frozen all the way down, so a translation that writes into what the client sent throws. */
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

/** A request of its own each time — the fixtures are shared between requests, as a client's history is — and frozen. */
function request(messages: unknown[], system = systemPrompt) {
  return frozen(
    structuredClone({
      model: 'claudecode:claude-sonnet-5-5',
      messages: [{ role: 'system', content: system }, ...messages],
      tools,
      user: 'nouva:telegram:1',
      prompt_cache_key: 'telegram:1',
      stream: true,
      stream_options: { include_usage: true },
    }),
  );
}

const translate = (body: unknown) => mapOpenAIToAnthropic(body, 'claude-sonnet-5-5', 128_000, 'claudecode');

interface Rendering {
  /** One string per block, in the order Anthropic renders them: tools, system, then every block of every message. */
  blocks: string[];
  /** The positions that carry a breakpoint. */
  marked: number[];
}

/** A request as Anthropic caches it. The marker is taken off each block: a breakpoint is not part of what it marks. */
function rendered(body: any): Rendering {
  const unmarked = ({ cache_control: _breakpoint, ...block }: any) => block;
  const system = typeof body.system === 'string' ? [{ type: 'text', text: body.system }] : (body.system ?? []);
  const entries: Array<[string, boolean]> = [
    ...(body.tools ?? []).map((tool: any): [string, boolean] => [`tool:${JSON.stringify(unmarked(tool))}`, Boolean(tool.cache_control)]),
    ...system.map((block: any): [string, boolean] => [`system:${JSON.stringify(unmarked(block))}`, Boolean(block.cache_control)]),
    ...body.messages.flatMap((message: any, index: number) =>
      message.content.map((block: any): [string, boolean] => [
        `${index}:${message.role}:${JSON.stringify(unmarked(block))}`,
        Boolean(block.cache_control),
      ]),
    ),
  ];
  return {
    blocks: entries.map(([block]) => block),
    marked: entries.flatMap(([, marked], position) => (marked ? [position] : [])),
  };
}

/**
 * How many leading blocks of `next` are read from what `previous` wrote: the longest entry `previous` wrote whose bytes
 * `next` repeats, with a breakpoint of `next`'s own at or after it within the lookback. 0 when none is.
 */
function readBack(previous: Rendering, next: Rendering): number {
  let longest = 0;
  for (const position of previous.marked) {
    const repeated = previous.blocks.slice(0, position + 1).every((block, index) => next.blocks[index] === block);
    const found = next.marked.some((mark) => mark >= position && mark - position <= LOOKBACK_BLOCKS);
    if (repeated && found) longest = Math.max(longest, position + 1);
  }
  return longest;
}

/** The position one past the block that holds `fragment` — how much of `next` a read through that block covers. */
function through(rendering: Rendering, fragment: string): number {
  const position = rendering.blocks.findIndex((block) => block.includes(fragment));
  if (position < 0) throw new Error(`no block holds ${fragment}`);
  return position + 1;
}

describe('the next request reads the conversation back from the cache', () => {
  test('a tool loop with work notes: everything but the notes is read back', () => {
    const first = rendered(translate(request([ask, askedDisk, disk, notes(1)])));
    const second = rendered(translate(request([ask, askedDisk, disk, askedInodes, inodes, notes(2)])));

    expect(readBack(first, second)).toBe(through(second, '"tool_use_id":"call_df"'));
  });

  test('a tool loop without notes: the whole first request is read back', () => {
    const first = rendered(translate(request([ask, askedDisk, disk])));
    const second = rendered(translate(request([ask, askedDisk, disk, askedInodes, inodes])));

    expect(readBack(first, second)).toBe(first.blocks.length);
  });

  test('a plain chat: the question already answered is read back', () => {
    const first = rendered(translate(request([ask])));
    const second = rendered(translate(request([ask, { role: 'assistant', content: '30% full.' }, { role: 'user', content: 'And inodes?' }])));

    expect(readBack(first, second)).toBe(first.blocks.length);
  });

  test('a system prompt that moved still finds the tools in the cache', () => {
    const first = rendered(translate(request([ask, askedDisk, disk])));
    const second = rendered(
      translate(request([ask, askedDisk, disk, askedInodes, inodes], systemPrompt.replace('2026-11-04', '2026-11-05'))),
    );

    expect(readBack(first, second)).toBe(tools.length);
  });
});

describe('where the breakpoints go', () => {
  test('the last tool, the system prompt, and the last block of each of the two newest messages', () => {
    const body = translate(request([ask, askedDisk, disk, askedInodes, inodes, notes(2)]));

    expect(body.tools.map((tool: any) => Boolean(tool.cache_control))).toEqual([false, true]);
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' });
    const marked = body.messages.flatMap((message: any) => message.content.filter((block: any) => block.cache_control));
    expect(marked).toEqual([
      { type: 'tool_result', tool_use_id: 'call_di', content: inodes.content, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'Work notes: step 2 of 3.', cache_control: { type: 'ephemeral' } },
    ]);
  });

  test("never more than Anthropic's four", () => {
    const history = [ask, askedDisk, disk, askedInodes, inodes, notes(2)];
    for (let length = 1; length <= history.length; length += 1) {
      const body = translate(request(history.slice(0, length)));
      expect(rendered(body).marked.length).toBeLessThanOrEqual(MAX_BREAKPOINTS);
    }
  });

  test('a short system prompt keeps its string form, and the conversation is still marked', () => {
    const body = translate(request([ask, askedDisk, disk], 'Be brief.'));

    expect(body.system).toBe('Be brief.');
    expect(rendered(body).marked.length).toBe(3);
  });

  test('tools the client withheld are not sent, so nothing marks them', () => {
    const body = translate({ ...request([ask]), tool_choice: 'none' });

    expect(body.tools).toBeUndefined();
    expect(rendered(body).marked.length).toBe(2);
  });

  test("the client's own request is left unmarked, for the next provider a failover hands it to", () => {
    // `request` freezes what it builds: a mark written into the client's own objects throws here.
    const sent = request([ask, askedDisk, disk, notes(1)]);
    const before = JSON.stringify(sent);
    translate(sent);

    expect(JSON.stringify(sent)).toBe(before);
  });
});

describe('the cache read reaches an OpenAI client', () => {
  const encoder = new TextEncoder();

  test('streamed: prompt_tokens is the whole prompt, cached_tokens the part the cache served', async () => {
    const events = [
      {
        type: 'message_start',
        message: {
          id: 'msg_1',
          usage: { input_tokens: 500, cache_creation_input_tokens: 1_500, cache_read_input_tokens: 8_000, output_tokens: 1 },
        },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '30% full.' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 50 } },
      { type: 'message_stop' },
    ];
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) {
          controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
        }
        controller.close();
      },
    });
    const sse = await new Response(
      source.pipeThrough(createAnthropicToOpenAIStreamTransformer('claudecode:claude-sonnet-5-5')),
    ).text();
    const usage = sse
      .split('\n')
      .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
      .map((line) => JSON.parse(line.slice(6)))
      .find((chunk) => chunk.usage)?.usage;

    expect(usage).toEqual({
      prompt_tokens: 10_000,
      completion_tokens: 50,
      total_tokens: 10_050,
      prompt_tokens_details: { cached_tokens: 8_000 },
    });
  });

  test('not streamed: the same figures, total_tokens the prompt and the completion together', async () => {
    const upstream = new Response(
      JSON.stringify({
        id: 'msg_1',
        content: [{ type: 'text', text: '30% full.' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 500, cache_creation_input_tokens: 1_500, cache_read_input_tokens: 8_000, output_tokens: 50 },
      }),
    );
    const body = await (await finalizeAnthropicToOpenAIResponse(upstream, 'claudecode:claude-sonnet-5-5')).json();

    expect(body.usage).toEqual({
      prompt_tokens: 10_000,
      completion_tokens: 50,
      total_tokens: 10_050,
      prompt_tokens_details: { cached_tokens: 8_000 },
    });
  });
});
