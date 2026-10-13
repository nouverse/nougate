import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import type { RotationConfig, ScoringConfig } from '@/config/types';
import { KiroAccountPool, type NewKiroAccount } from '@/providers/kiro/auth/manager';
import { clearPendingDeviceLogins, pollDeviceFlow, startDeviceFlow } from '@/providers/kiro/auth/device-flow';
import { mapUsageLimits, mergeAccountQuotas } from '@/providers/kiro/auth/quota';
import { canRefresh, needsRefresh } from '@/providers/kiro/auth/refresh';
import { parseExternalIdpAuth } from '@/providers/kiro/auth/token-import';
import type { KiroAccount, KiroAccountsFile } from '@/providers/kiro/auth/types';
import { kiroModelRegistry, resolveKiroModel } from '@/providers/kiro/config/model-specs';
import { buildAdditionalModelRequestFields, resolveThinkingBudget } from '@/providers/kiro/config/reasoning';
import { toPublicAccount } from '@/providers/kiro';
import { AnthropicStreamEncoder, buildAnthropicMessage, convertAnthropicMessages } from '@/providers/kiro/mappers/anthropic';
import { canonicalizeConversation, normalizeToolSpecs } from '@/providers/kiro/mappers/conversation';
import { OpenAIStreamEncoder, buildOpenAICompletion, convertOpenAIMessages } from '@/providers/kiro/mappers/openai';
import { prepareKiroRequest } from '@/providers/kiro/mappers/payload';
import { streamKiroResponse } from '@/providers/kiro/mappers/response';
import { KiroStreamInterpreter, ThinkingSplitter, type KiroEvent } from '@/providers/kiro/mappers/stream-events';
import { clearSessionReplayStore } from '@/providers/kiro/session-replay';
import { chatEndpoints, resolveProfileArn } from '@/providers/kiro/upstream/endpoints';
import { buildChatHeaders } from '@/providers/kiro/upstream/headers';
import { KiroExecutor } from '@/providers/kiro/upstream/executor';
import { KiroResponseReader } from '@/providers/kiro/upstream/stream-reader';
import { EventStreamDecoder, crc32, encodeEventFrame, parseEventFrame } from '@/providers/kiro/wire/event-stream';
import { UnsupportedContentPartError } from '@/core/upstream-errors';

// ─── Fixtures ──────────────────────────────────────────────────────────────

const event = (eventType: string, payload: unknown) =>
  encodeEventFrame({ ':message-type': 'event', ':event-type': eventType, ':content-type': 'application/json' }, payload);

const exception = (exceptionType: string, message: string) =>
  encodeEventFrame({ ':message-type': 'exception', ':exception-type': exceptionType }, { message });

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function interpreter(options: Partial<ConstructorParameters<typeof KiroStreamInterpreter>[0]> = {}) {
  return new KiroStreamInterpreter({ inlineThinking: false, maxToolInputBytes: 1024 * 1024, ...options });
}

/** Feed frames one byte at a time — the harshest possible chunking — and collect everything. */
function runBytewise(frames: Uint8Array[], options: Partial<ConstructorParameters<typeof KiroStreamInterpreter>[0]> = {}): KiroEvent[] {
  const it = interpreter(options);
  const bytes = concat(...frames);
  const events: KiroEvent[] = [];
  for (let i = 0; i < bytes.length; i++) events.push(...it.pushBytes(bytes.subarray(i, i + 1)));
  events.push(...it.end());
  return events;
}

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

const SCORING: ScoringConfig = {
  healthRange: { min: 0, max: 100, initial: 100 },
  penalties: { apiError: -10, refreshError: -20, fatalError: -50, systemicError: -10 },
  rewards: { success: 2 },
  weights: { health: 2, lru: 0.1, quota: 0 },
};
const ROTATION: RotationConfig = { strategy: 'hybrid', cooldown: { defaultDurationMs: 60_000, maxDurationMs: 3_600_000 } };

function pool(): { pool: KiroAccountPool; saves: Array<{ data: KiroAccountsFile; immediate: boolean }> } {
  const saves: Array<{ data: KiroAccountsFile; immediate: boolean }> = [];
  return {
    pool: new KiroAccountPool({
      persist: (data, immediate) => saves.push({ data: structuredClone(data), immediate }),
      scoring: () => SCORING,
      rotation: () => ROTATION,
    }),
    saves,
  };
}

const socialAccount = (overrides: Partial<NewKiroAccount> = {}): NewKiroAccount => ({
  authMethod: 'social',
  accessToken: 'aoa-access-token-000000000000',
  refreshToken: 'aor-refresh-token-0000000000',
  expiresAt: Date.now() + 3_600_000,
  region: 'us-east-1',
  ...overrides,
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.MAX_ACCOUNT_MULTIPLEXING;
  clearSessionReplayStore();
});

// ─── Wire: AWS EventStream ─────────────────────────────────────────────────

describe('kiro wire: event-stream', () => {
  test('crc32 matches the IEEE check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  test('a frame round-trips through encode and parse', () => {
    const frame = parseEventFrame(event('assistantResponseEvent', { content: 'héllo' }));
    expect(frame.headers[':event-type']).toBe('assistantResponseEvent');
    expect(frame.payload).toEqual({ content: 'héllo' });
  });

  test('the incremental decoder yields every frame however the bytes are split', () => {
    const bytes = concat(event('a', { n: 1 }), event('b', { n: 2 }), event('c', null));
    const decoder = new EventStreamDecoder();
    const frames = [];
    for (let i = 0; i < bytes.length; i += 7) frames.push(...decoder.push(bytes.subarray(i, i + 7)));
    expect(frames.map((frame) => frame.headers[':event-type'])).toEqual(['a', 'b', 'c']);
    expect(frames[2]!.payload).toBeNull();
    expect(decoder.bufferedBytes).toBe(0);
  });

  test('only the unfinished frame is retained between pushes', () => {
    const frame = event('assistantResponseEvent', { content: 'x'.repeat(500) });
    const decoder = new EventStreamDecoder();
    decoder.push(frame.subarray(0, 100));
    expect(decoder.bufferedBytes).toBe(100);
    expect(decoder.push(frame.subarray(100))).toHaveLength(1);
    expect(decoder.bufferedBytes).toBe(0);
  });

  test('a corrupted prelude is rejected before its declared length is waited for', () => {
    const frame = event('a', { n: 1 });
    frame[0] ^= 0xff;
    expect(() => new EventStreamDecoder().push(frame.subarray(0, 12))).toThrow(/prelude CRC/);
  });

  test('a corrupted payload fails the message CRC', () => {
    const frame = event('a', { content: 'abc' });
    frame[frame.length - 6] ^= 0x01;
    expect(() => parseEventFrame(frame)).toThrow(/message CRC/);
  });
});

// ─── Stream interpretation ─────────────────────────────────────────────────

describe('kiro stream interpreter', () => {
  test('text streams as it decodes and the turn ends with stop', () => {
    const events = runBytewise([
      event('assistantResponseEvent', { content: 'Hello' }),
      event('assistantResponseEvent', { content: ', world' }),
      event('messageStopEvent', {}),
    ]);
    expect(events.filter((e) => e.type === 'text').map((e) => (e as any).text).join('')).toBe('Hello, world');
    expect(events.at(-1)).toEqual({ type: 'end', finishReason: 'stop', usage: null });
  });

  test('inline <thinking> is preserved as reasoning, even with tags split across frames', () => {
    const events = runBytewise(
      [
        event('assistantResponseEvent', { content: '<thin' }),
        event('assistantResponseEvent', { content: 'king>\nweighing options' }),
        event('assistantResponseEvent', { content: ' carefully</thi' }),
        event('assistantResponseEvent', { content: 'nking>\nThe answer is 4.' }),
      ],
      { inlineThinking: true },
    );
    const reasoning = events.filter((e) => e.type === 'reasoning').map((e) => (e as any).text).join('');
    const text = events.filter((e) => e.type === 'text').map((e) => (e as any).text).join('');
    expect(reasoning).toBe('weighing options carefully');
    expect(text).toBe('The answer is 4.');
    expect(text).not.toContain('<');
  });

  test('without inline thinking, a literal <thinking> in the answer is left alone', () => {
    const events = runBytewise([event('assistantResponseEvent', { content: 'use <thinking> tags' })]);
    expect(events[0]).toEqual({ type: 'text', text: 'use <thinking> tags' });
  });

  test('the splitter releases a held-back partial tag that never completes', () => {
    const splitter = new ThinkingSplitter();
    expect(splitter.push('a <thi')).toEqual([{ kind: 'text', text: 'a ' }]);
    expect(splitter.flush()).toEqual([{ kind: 'text', text: '<thi' }]);
  });

  test('native reasoningContentEvent frames become reasoning', () => {
    const events = runBytewise([
      event('reasoningContentEvent', { text: 'step one' }),
      event('assistantResponseEvent', { content: 'done' }),
    ]);
    expect(events.slice(0, 2)).toEqual([
      { type: 'reasoning', text: 'step one' },
      { type: 'text', text: 'done' },
    ]);
  });

  test('a fragmented tool call is emitted whole on its stop marker, under the client name', () => {
    const it = interpreter({ toolNameMap: new Map([['read_file', 'mcp.read_file']]) });
    const early = it.pushBytes(
      concat(
        event('toolUseEvent', { name: 'read_file', toolUseId: 't1', input: '{"pa' }),
        event('toolUseEvent', { name: 'read_file', toolUseId: 't1', input: 'th":"/a"}' }),
      ),
    );
    expect(early).toEqual([]);
    const done = it.pushBytes(event('toolUseEvent', { name: 'read_file', toolUseId: 't1', stop: true }));
    expect(done).toEqual([{ type: 'tool_call', id: 't1', name: 'mcp.read_file', arguments: '{"path":"/a"}' }]);
    expect(it.end().at(-1)).toMatchObject({ type: 'end', finishReason: 'tool_calls' });
  });

  test('an unusable tool call is dropped without discarding the text of the turn', () => {
    const events = runBytewise([
      event('assistantResponseEvent', { content: 'Let me look.' }),
      event('toolUseEvent', { name: 'read_file', toolUseId: 't1', input: '{"broken' }),
      event('messageStopEvent', { stopReason: 'tool_use' }),
    ]);
    expect(events.some((e) => e.type === 'tool_call')).toBe(false);
    expect(events[0]).toEqual({ type: 'text', text: 'Let me look.' });
    expect(events.at(-1)).toMatchObject({ type: 'end', finishReason: 'stop' });
  });

  test('a turn whose only output was an unusable tool call is an error', () => {
    const events = runBytewise([event('toolUseEvent', { name: 'tool_call', toolUseId: 't1', input: '{}', stop: true })]);
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'invalid_kiro_tool_call' });
  });

  test('max_tokens after output closes as length; a refusal is an error', () => {
    const truncated = runBytewise([
      event('assistantResponseEvent', { content: 'partial' }),
      event('messageStopEvent', { stopReason: 'MAX_TOKENS' }),
    ]);
    expect(truncated.at(-1)).toMatchObject({ type: 'end', finishReason: 'length' });

    const refused = runBytewise([event('metadataEvent', { stopReason: 'content_filtered' })]);
    expect(refused.at(-1)).toMatchObject({ type: 'error', code: 'kiro_terminal_refusal' });
  });

  test('an exception frame becomes an error carrying an HTTP-equivalent status', () => {
    const events = runBytewise([exception('ThrottlingException', 'slow down')]);
    expect(events).toEqual([{ type: 'error', code: 'kiro_upstream_eventstream_error', message: 'slow down', status: 429 }]);
  });

  test('a stream cut mid-frame is an error, not a short answer', () => {
    const it = interpreter();
    const frame = event('assistantResponseEvent', { content: 'Hello' });
    it.pushBytes(frame);
    it.pushBytes(event('assistantResponseEvent', { content: 'more' }).subarray(0, 20));
    expect(it.end()).toEqual([{ type: 'error', code: 'kiro_missing_terminal', message: 'Kiro EventStream ended with a truncated frame', status: 502 }]);
  });

  test('usage: real token metrics win; context percentage is scaled only by a declared window', () => {
    const measured = runBytewise([
      event('assistantResponseEvent', { content: 'x' }),
      event('metricsEvent', { inputTokens: 120, outputTokens: 7, cacheReadInputTokens: 100 }),
      event('meteringEvent', { usage: 0.25, unit: 'credit' }),
    ]);
    expect(measured.at(-1)).toMatchObject({
      type: 'end',
      usage: { promptTokens: 120, completionTokens: 7, cacheReadTokens: 100, credits: 0.25, creditUnit: 'credit' },
    });

    const frames = [event('assistantResponseEvent', { content: 'x' }), event('contextUsageEvent', { contextUsagePercentage: 1.5 })];
    expect(runBytewise(frames, { contextWindow: 200_000 }).at(-1)).toMatchObject({ usage: { promptTokens: 3000 } });
    expect(runBytewise(frames).at(-1)).toMatchObject({ type: 'end', usage: null });
  });
});

// ─── Request mapping ───────────────────────────────────────────────────────

describe('kiro request mapping', () => {
  test('OpenAI: system becomes instructions, tool calls pair with tool results', () => {
    const { history, currentMessage } = convertOpenAIMessages(
      [
        { role: 'system', content: 'Be terse.' },
        { role: 'user', content: 'Read /a' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"p":"/a"}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'file body' },
      ],
      'claude-sonnet-4.5',
      { images: true },
    );
    expect(history[0]!.userInputMessage!.content).toBe('<instructions>\nBe terse.\n</instructions>\n\nRead /a');
    expect(history[1]!.assistantResponseMessage!.toolUses).toEqual([{ toolUseId: 'c1', name: 'read', input: { p: '/a' } }]);
    expect(currentMessage.userInputMessage.content).toBe('Tool results provided.');
    expect(currentMessage.userInputMessage.userInputMessageContext!.toolResults).toEqual([
      { toolUseId: 'c1', status: 'success', content: [{ text: 'file body' }] },
    ]);
  });

  test('OpenAI: data-URI images are forwarded; audio and images on a text-only model are refused', () => {
    const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } };
    const { currentMessage } = convertOpenAIMessages([{ role: 'user', content: [{ type: 'text', text: 'see' }, image] }], 'm', { images: true });
    expect(currentMessage.userInputMessage.images).toEqual([{ format: 'png', source: { bytes: 'AAAA' } }]);

    expect(() => convertOpenAIMessages([{ role: 'user', content: [image] }], 'm', { images: false })).toThrow(UnsupportedContentPartError);
    expect(() =>
      convertOpenAIMessages([{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'x', format: 'wav' } }] }], 'm', { images: true }),
    ).toThrow(UnsupportedContentPartError);
  });

  test('Anthropic: tool_result images ride along as user images, is_error is kept', () => {
    const { history, currentMessage } = convertAnthropicMessages(
      [
        { role: 'user', content: 'screenshot please' },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'tool_use', id: 'tu1', name: 'shot', input: {} }] },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu1',
              is_error: true,
              content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBBB' } }],
            },
          ],
        },
      ],
      'claude-sonnet-4.5',
      { images: true },
    );
    expect(history[1]!.assistantResponseMessage).toEqual({ content: '...', toolUses: [{ toolUseId: 'tu1', name: 'shot', input: {} }] });
    expect(currentMessage.userInputMessage.images).toEqual([{ format: 'jpeg', source: { bytes: 'BBBB' } }]);
    expect(currentMessage.userInputMessage.userInputMessageContext!.toolResults![0]).toEqual({
      toolUseId: 'tu1',
      status: 'error',
      content: [{ text: '(image attached)' }],
    });
  });

  test('tool specs are sanitised and their schemas cleaned', () => {
    const { specs, nameMap } = normalizeToolSpecs([
      { name: 'mcp.fs/read', description: 'read', input_schema: { type: 'object', additionalProperties: false, required: [], properties: { p: { type: 'string' } } } },
    ]);
    expect(nameMap.get('mcp.fs/read')).toBe('mcp_fs_read');
    expect(specs[0]!.toolSpecification.inputSchema.json).toEqual({ type: 'object', properties: { p: { type: 'string' } } });
  });

  test('an orphaned tool result is flattened to text instead of failing the request', () => {
    const canonical = canonicalizeConversation({
      history: [
        { userInputMessage: { content: 'hi' } },
        { assistantResponseMessage: { content: 'ok' } },
      ],
      currentMessage: {
        userInputMessage: {
          content: '',
          userInputMessageContext: { toolResults: [{ toolUseId: 'gone', status: 'success', content: [{ text: 'stale' }] }] },
        },
      },
      modelId: 'm',
    });
    expect(canonical.valid).toBe(true);
    expect(canonical.currentMessage.userInputMessage.content).toContain('[Tool result: stale]');
    expect(canonical.currentMessage.userInputMessage.userInputMessageContext).toBeUndefined();
    expect(canonical.repairs.orphanResults).toBe(1);
  });

  test('model suffixes and thinking intent resolve as documented', () => {
    expect(resolveKiroModel('claude-sonnet-4.5-thinking-agentic')).toEqual({ upstream: 'claude-sonnet-4.5', agentic: true, thinking: true });
    expect(kiroModelRegistry.getSpec('claude-sonnet-4.5(high)')?.modelId).toBe('claude-sonnet-4.5');
    expect(kiroModelRegistry.getSpec('deepseek-3.2-thinking')).toBeNull();
    expect(kiroModelRegistry.getSpec('nope')).toBeNull();
    expect(resolveThinkingBudget({ thinking: { type: 'disabled' } }, null, 'x-thinking')).toBeNull();
    expect(resolveThinkingBudget({ reasoning_effort: 'low' }, null, 'm')).toBe(1024);
    expect(buildAdditionalModelRequestFields({ reasoning_effort: 'xhigh' }, 'claude-opus-4.6')).toEqual({
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'high' },
    });
    expect(buildAdditionalModelRequestFields({ reasoning_effort: 'max' }, 'gpt-5.6-sol')).toEqual({ reasoning: { effort: 'xhigh' } });
    expect(buildAdditionalModelRequestFields({ reasoning_effort: 'high' }, 'claude-sonnet-4.5')).toBeUndefined();
  });

  test('payload: thinking tag and agentic prompt lead the first turn; no top-level systemPrompt', () => {
    const prepared = prepareKiroRequest({
      requestedModel: 'claude-sonnet-4.5-thinking-agentic',
      body: { messages: [{ role: 'user', content: 'hi' }] },
      headers: null,
      tools: [],
      systemText: 'SYS',
      convert: (model) => convertAnthropicMessages([{ role: 'user', content: 'hi' }], model, { images: true }),
    });
    expect(prepared.inlineThinking).toBe(true);
    const payload: any = prepared.forAccount({ id: 'a', authMethod: 'builder-id' });
    const content: string = payload.conversationState.currentMessage.userInputMessage.content;
    expect(content.startsWith('<thinking_mode>enabled</thinking_mode>\n<max_thinking_length>16000</max_thinking_length>')).toBe(true);
    expect(content).toContain('CHUNKED WRITE PROTOCOL');
    expect(content).toContain('SYS');
    expect(content.endsWith('hi')).toBe(true);
    expect(payload.systemPrompt).toBeUndefined();
    expect(payload.conversationState.currentMessage.userInputMessage.modelId).toBe('claude-sonnet-4.5');
    expect(payload.inferenceConfig).toEqual({ maxTokens: 32000 });
  });

  test('profile ARN: shared default only for OAuth-family accounts', () => {
    expect(resolveProfileArn({ authMethod: 'social' })).toContain(':699475941385:');
    expect(resolveProfileArn({ authMethod: 'builder-id' })).toContain(':638616132270:');
    expect(resolveProfileArn({ authMethod: 'api_key' })).toBeUndefined();
    expect(resolveProfileArn({ authMethod: 'idc' })).toBeUndefined();
    expect(resolveProfileArn({ authMethod: 'idc', profileArn: 'arn:own' })).toBe('arn:own');
  });

  test('endpoints: Amazon surfaces first and regionalised; API keys never hit the IDE gateway', () => {
    expect(chatEndpoints({ authMethod: 'idc', region: 'eu-central-1' }).map((e) => e.url)).toEqual([
      'https://q.eu-central-1.amazonaws.com/generateAssistantResponse',
      'https://codewhisperer.eu-central-1.amazonaws.com/generateAssistantResponse',
      'https://runtime.us-east-1.kiro.dev/generateAssistantResponse',
    ]);
    expect(chatEndpoints({ authMethod: 'api_key', region: 'us-east-1' }).map((e) => e.surface)).toEqual(['q', 'codewhisperer']);
    expect(() => chatEndpoints({ authMethod: 'social', region: 'evil.com/x' })).toThrow(/Invalid AWS region/);
  });

  test('headers: token-type markers per method, X-Amz-Target only on CodeWhisperer', () => {
    const key = buildChatHeaders({ authMethod: 'api_key', accessToken: 'k' }, 'q');
    expect(key.TokenType).toBe('API_KEY');
    expect(key['X-Amz-Target']).toBeUndefined();
    const idp = buildChatHeaders({ authMethod: 'external_idp', accessToken: 't', profileArn: 'arn:p' }, 'codewhisperer');
    expect(idp.TokenType).toBe('EXTERNAL_IDP');
    expect(idp['X-Amz-Target']).toBe('AmazonCodeWhispererStreamingService.GenerateAssistantResponse');
    expect(idp['x-amzn-codewhisperer-profile-arn']).toBe('arn:p');
  });
});

// ─── Session replay ────────────────────────────────────────────────────────

describe('kiro session replay', () => {
  const turn = (content: string) => ({ role: 'user', content });
  const prepare = (messages: any[]) =>
    prepareKiroRequest({
      requestedModel: 'claude-sonnet-4.5',
      body: { messages, metadata: { user_id: 'user_x_session_0f0f0f0f-aaaa-bbbb-cccc-111122223333' } },
      headers: null,
      tools: [],
      systemText: 'SYSTEM',
      convert: (model) => convertAnthropicMessages(messages, model, { images: true }),
    }).forAccount({ id: 'acct', authMethod: 'social' }) as any;

  test('the first turn of a conversation is replayed byte-identically on later turns', async () => {
    const first = prepare([turn('hello')]);
    const frozen = first.conversationState.currentMessage.userInputMessage.content;
    expect(frozen).toContain('SYSTEM');

    await Bun.sleep(5); // a later timestamp must not leak into the cached prefix
    const second = prepare([turn('hello'), { role: 'assistant', content: 'hi!' }, turn('next')]);
    expect(second.conversationState.history[0].userInputMessage.content).toBe(frozen);
    expect(second.conversationState.conversationId).toBe(first.conversationState.conversationId);
    const current: string = second.conversationState.currentMessage.userInputMessage.content;
    expect(current).toMatch(/^\[Context: Current time is .+\]\n\nnext$/);
  });
});

// ─── Response mapping ──────────────────────────────────────────────────────

const SAMPLE_EVENTS: KiroEvent[] = [
  { type: 'reasoning', text: 'think' },
  { type: 'text', text: 'Hi' },
  { type: 'tool_call', id: 't1', name: 'read', arguments: '{"p":1}' },
  { type: 'end', finishReason: 'tool_calls', usage: { promptTokens: 10, completionTokens: 3, cacheReadTokens: 6 } },
];

function sseData(text: string): any[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice(6)));
}

describe('kiro response mapping', () => {
  test('OpenAI stream: reasoning_content, a whole tool call, usage with cache folded into the prompt', () => {
    const encoder = new OpenAIStreamEncoder('kiro:m');
    const out = SAMPLE_EVENTS.map((e) => encoder.encode(e)).join('');
    const chunks = sseData(out);
    expect(chunks[0].choices[0].delta).toEqual({ role: 'assistant', reasoning_content: 'think' });
    expect(chunks[1].choices[0].delta).toEqual({ content: 'Hi' });
    expect(chunks[2].choices[0].delta.tool_calls[0]).toMatchObject({ index: 0, id: 't1', function: { name: 'read' } });
    expect(chunks[3].choices[0].delta.tool_calls[0].function.arguments).toBe('{"p":1}');
    expect(chunks.at(-1).choices[0].finish_reason).toBe('tool_calls');
    expect(chunks.at(-1).usage).toMatchObject({ prompt_tokens: 16, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 6 } });
    expect(out.endsWith('data: [DONE]\n\n')).toBe(true);
  });

  test('Anthropic stream: a real thinking block, then text, then tool_use, then message_delta', () => {
    const encoder = new AnthropicStreamEncoder('kiro:m', 'msg_1');
    const out = encoder.start() + SAMPLE_EVENTS.map((e) => encoder.encode(e)).join('');
    const events = sseData(out);
    expect(events.map((e) => e.type)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    expect(events[1].content_block).toEqual({ type: 'thinking', thinking: '' });
    expect(events[2].delta).toEqual({ type: 'thinking_delta', thinking: 'think' });
    expect(events[7].content_block).toEqual({ type: 'tool_use', id: 't1', name: 'read', input: {} });
    expect(events[10]).toMatchObject({
      delta: { stop_reason: 'tool_use' },
      usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 6 },
    });
  });

  test('non-streaming builders produce complete messages', () => {
    const completion: any = buildOpenAICompletion(SAMPLE_EVENTS, 'kiro:m');
    expect(completion.choices[0].message).toMatchObject({ content: 'Hi', reasoning_content: 'think' });
    expect(completion.choices[0].finish_reason).toBe('tool_calls');

    const message: any = buildAnthropicMessage(SAMPLE_EVENTS, 'kiro:m', 'msg_1');
    expect(message.content).toEqual([
      { type: 'thinking', thinking: 'think' },
      { type: 'text', text: 'Hi' },
      { type: 'tool_use', id: 't1', name: 'read', input: { p: 1 } },
    ]);
    expect(message.stop_reason).toBe('tool_use');
  });

  test('the client receives text before the upstream has finished', async () => {
    let upstream!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start: (controller) => void (upstream = controller) });
    upstream.enqueue(event('assistantResponseEvent', { content: 'first' }));

    const reader = new KiroResponseReader(body, interpreter());
    const primed = await reader.prime();
    const response = streamKiroResponse(reader, primed, new OpenAIStreamEncoder('kiro:m'));
    const client = response.body!.getReader();

    const firstChunk = new TextDecoder().decode((await client.read()).value);
    expect(firstChunk).toContain('"content":"first"');

    upstream.enqueue(event('assistantResponseEvent', { content: ' second' }));
    upstream.close();
    let rest = '';
    while (true) {
      const { done, value } = await client.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    expect(rest).toContain('"content":" second"');
    expect(rest).toContain('"finish_reason":"stop"');
    expect(rest.endsWith('data: [DONE]\n\n')).toBe(true);
  });
});

// ─── Account lifecycle ─────────────────────────────────────────────────────

describe('kiro account lifecycle', () => {
  test('a new account is stored immediately; signing in again updates it in place', () => {
    const { pool: accounts, saves } = pool();
    const first = accounts.upsert(socialAccount({ email: 'a@example.com' }));
    expect(saves.at(-1)!.immediate).toBe(true);
    expect(first.label).toBe('a@example.com');

    accounts.invalidate(first.id, 'expired');
    const again = accounts.upsert(socialAccount({ email: 'a@example.com', accessToken: 'new-access-token-00000' }));
    expect(again.id).toBe(first.id);
    expect(accounts.list()).toHaveLength(1);
    expect(again.accessToken).toBe('new-access-token-00000');
    expect(again.invalidatedAt).toBeUndefined();
  });

  test('the multiplexing cap blocks new accounts but never a re-auth', () => {
    process.env.MAX_ACCOUNT_MULTIPLEXING = '1';
    const { pool: accounts } = pool();
    accounts.upsert(socialAccount({ email: 'a@example.com' }));
    expect(() => accounts.upsert(socialAccount({ email: 'b@example.com', refreshToken: 'aor-other' }))).toThrow();
    expect(() => accounts.upsert(socialAccount({ email: 'a@example.com' }))).not.toThrow();
  });

  test('rotation picks the healthiest, skips cooldowns, exclusions and invalid accounts, and returns null when empty', () => {
    const { pool: accounts } = pool();
    expect(accounts.best()).toBeNull();

    const a = accounts.upsert(socialAccount({ email: 'a@example.com', refreshToken: 'aor-a' }));
    const b = accounts.upsert(socialAccount({ email: 'b@example.com', refreshToken: 'aor-b' }));
    accounts.recordResult(a.id, false, { status: 500 });
    expect(accounts.best()?.id).toBe(b.id);

    accounts.markCooldown(b.id, 'claude-sonnet-4.5', 60_000);
    expect(accounts.best({ modelId: 'claude-sonnet-4.5' })?.id).toBe(a.id);
    expect(accounts.best({ modelId: 'claude-haiku-4.5' })?.id).toBe(b.id);
    expect(accounts.best({ excludeIds: [b.id] })?.id).toBe(a.id);

    accounts.invalidate(a.id, 'gone');
    expect(accounts.best({ modelId: 'claude-sonnet-4.5' })).toBeNull();
  });

  test('a success clears the model cooldown and renewed tokens clear invalidation', () => {
    const { pool: accounts } = pool();
    const a = accounts.upsert(socialAccount());
    accounts.markCooldown(a.id, 'm', 60_000);
    accounts.recordResult(a.id, true, { modelId: 'm' });
    expect(accounts.find(a.id)!.cooldowns?.m).toBeUndefined();

    accounts.invalidate(a.id, 'x');
    accounts.storeTokens(a.id, { accessToken: 'fresh', expiresIn: 60 });
    expect(accounts.find(a.id)!.invalidatedAt).toBeUndefined();
    expect(accounts.find(a.id)!.accessToken).toBe('fresh');
  });

  test('removal drops the account; refresh rules follow the auth method', () => {
    const { pool: accounts } = pool();
    const a = accounts.upsert(socialAccount());
    expect(accounts.remove(a.id)).toBe(true);
    expect(accounts.list()).toHaveLength(0);

    expect(canRefresh({ authMethod: 'api_key', region: 'us-east-1' })).toBe(false);
    expect(canRefresh({ authMethod: 'builder-id', refreshToken: 'r', region: 'us-east-1' })).toBe(false);
    expect(canRefresh({ authMethod: 'builder-id', refreshToken: 'r', clientId: 'c', clientSecret: 's', region: 'us-east-1' })).toBe(true);
    expect(needsRefresh({ authMethod: 'social', refreshToken: 'r', region: 'us-east-1', expiresAt: Date.now() + 60_000 })).toBe(true);
  });

  test('credentials never reach the dashboard shape', () => {
    const { pool: accounts } = pool();
    const account = accounts.upsert(socialAccount({ clientSecret: 'secret-value' }));
    const shown = JSON.stringify(toPublicAccount(account));
    expect(shown).not.toContain(account.accessToken);
    expect(shown).not.toContain(account.refreshToken!);
    expect(shown).not.toContain('secret-value');
    expect(toPublicAccount(account).email).toBe('aor-…0000');
  });

  test('external IdP import only renews against Microsoft endpoints', () => {
    const base = {
      access_token: 'a',
      refresh_token: 'r',
      client_id: 'c',
      scopes: ['openid', 'offline_access'],
      profile_arn: 'arn:aws:codewhisperer:eu-central-1:1:profile/X',
    };
    const parsed = parseExternalIdpAuth({ ...base, token_endpoint: 'https://login.microsoftonline.com/t/oauth2/v2.0/token' });
    expect(parsed).toMatchObject({ authMethod: 'external_idp', region: 'eu-central-1', scope: 'openid offline_access' });
    expect(() => parseExternalIdpAuth({ ...base, token_endpoint: 'https://evil.example.com/token' })).toThrow(/Microsoft/);
  });
});

// ─── Device flow ───────────────────────────────────────────────────────────

describe('kiro device flow', () => {
  beforeEach(() => clearPendingDeviceLogins());

  test('register → authorize → pending → tokens, with the client secret kept server-side', async () => {
    let polls = 0;
    globalThis.fetch = (async (url: string) => {
      if (url.endsWith('/client/register')) return Response.json({ clientId: 'cid', clientSecret: 'csecret' });
      if (url.endsWith('/device_authorization')) {
        return Response.json({ deviceCode: 'dev1', userCode: 'ABCD-EFGH', verificationUri: 'https://v', expiresIn: 600, interval: 5 });
      }
      if (url.endsWith('/token')) {
        polls++;
        return polls === 1
          ? Response.json({ error: 'authorization_pending' }, { status: 400 })
          : Response.json({ accessToken: 'at', refreshToken: 'rt', expiresIn: 3600 });
      }
      throw new Error(`unexpected ${url}`);
    }) as unknown as typeof fetch;

    const started = await startDeviceFlow();
    expect(started).toMatchObject({ step: 'device_flow', device_code: 'dev1', user_code: 'ABCD-EFGH' });
    expect(JSON.stringify(started)).not.toContain('csecret');

    expect(await pollDeviceFlow('dev1')).toEqual({ status: 'pending', error: 'authorization_pending' });
    const done = await pollDeviceFlow('dev1');
    expect(done).toMatchObject({
      status: 'success',
      login: { authMethod: 'builder-id', clientId: 'cid', clientSecret: 'csecret', region: 'us-east-1' },
      tokens: { accessToken: 'at', refreshToken: 'rt' },
    });
    expect((await pollDeviceFlow('dev1')).status).toBe('expired');
  });
});

// ─── Quota ─────────────────────────────────────────────────────────────────

describe('kiro quota', () => {
  const LIMITS = {
    nextDateReset: 1_800_000_000,
    subscriptionInfo: { subscriptionTitle: 'KIRO FREE' },
    usageBreakdownList: [
      {
        resourceType: 'AGENTIC_REQUEST',
        currentUsageWithPrecision: 12.5,
        usageLimitWithPrecision: 50,
        freeTrialInfo: { currentUsageWithPrecision: 100, usageLimitWithPrecision: 500, freeTrialStatus: 'ACTIVE' },
      },
    ],
  };

  test('usage limits map to paid and free-trial quotas', () => {
    const quotas = mapUsageLimits(LIMITS, 1_799_000_000_000);
    expect(quotas).toEqual([
      expect.objectContaining({ id: 'agentic_request', remainingFraction: 0.75, used: '12.5', limit: '50', unit: 'credits' }),
      expect.objectContaining({ id: 'agentic_request_freetrial', remainingFraction: 0.8, used: '100', limit: '500' }),
    ]);
  });

  test('a zero limit is not divided; a pool averages fractions and sums usage', () => {
    const [zero] = mapUsageLimits({ usageBreakdownList: [{ resourceType: 'X', currentUsageWithPrecision: 0, usageLimitWithPrecision: 0 }] });
    expect(zero!.remainingFraction).toBe(0);
    expect(zero!.limit).toBeUndefined();

    const one = mapUsageLimits(LIMITS).slice(0, 1);
    const merged = mergeAccountQuotas([one, [{ ...one[0]!, remainingFraction: 0.25, used: '37.5' }]]);
    expect(merged).toEqual([expect.objectContaining({ id: 'agentic_request', remainingFraction: 0.5, used: '50' })]);
    expect(merged[0]!.limit).toBeUndefined();
  });
});

// ─── Executor ──────────────────────────────────────────────────────────────

describe('kiro executor', () => {
  const prepared = () =>
    prepareKiroRequest({
      requestedModel: 'claude-sonnet-4.5',
      body: {},
      headers: null,
      tools: [],
      systemText: '',
      convert: (model) => convertOpenAIMessages([{ role: 'user', content: 'hi' }], model, { images: true }),
    });
  const spec = kiroModelRegistry.getSpec('claude-sonnet-4.5')!;
  const eventStream = (...frames: Uint8Array[]) => new Response(streamOf(...frames), { status: 200 });

  test('a surface that refuses the token hands on to the next one', async () => {
    const { pool: accounts } = pool();
    const account = accounts.upsert(socialAccount());
    const hosts: string[] = [];
    globalThis.fetch = (async (url: string) => {
      hosts.push(new URL(url).host);
      if (url.includes('://q.')) return new Response('nope', { status: 403 });
      return eventStream(event('assistantResponseEvent', { content: 'ok' }));
    }) as unknown as typeof fetch;

    const result = await new KiroExecutor(accounts).execute({ prepared: prepared(), modelSpec: spec });
    expect(hosts).toEqual(['q.us-east-1.amazonaws.com', 'codewhisperer.us-east-1.amazonaws.com']);
    expect(result.accountId).toBe(account.id);
    expect(result.primed).toEqual([{ type: 'text', text: 'ok' }]);
  });

  test('in-stream throttling benches the account and the next one serves', async () => {
    const { pool: accounts } = pool();
    const a = accounts.upsert(socialAccount({ email: 'a@x', refreshToken: 'aor-a' }));
    const b = accounts.upsert(socialAccount({ email: 'b@x', refreshToken: 'aor-b', accessToken: 'token-b-000000000000' }));
    accounts.recordResult(b.id, false, { status: 500 }); // make `a` the first choice

    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const auth = (init.headers as Record<string, string>).Authorization;
      return auth.includes('token-b')
        ? eventStream(event('assistantResponseEvent', { content: 'from b' }))
        : eventStream(exception('ThrottlingException', 'Too many requests'));
    }) as unknown as typeof fetch;

    const result = await new KiroExecutor(accounts).execute({ prepared: prepared(), modelSpec: spec });
    expect(result.accountId).toBe(b.id);
    expect(result.attempts).toBe(2);
    expect(accounts.find(a.id)!.cooldowns?.['claude-sonnet-4.5']).toBeGreaterThan(Date.now());
  });

  test('a 400 is the request’s fault: it is thrown, and no account is penalised', async () => {
    const { pool: accounts } = pool();
    const account = accounts.upsert(socialAccount());
    globalThis.fetch = (async () =>
      Response.json({ message: 'Improperly formed request.', reason: 'REQUEST_BODY_INVALID' }, { status: 400 })) as unknown as typeof fetch;

    await expect(new KiroExecutor(accounts).execute({ prepared: prepared(), modelSpec: spec })).rejects.toMatchObject({
      status: 400,
      message: 'Improperly formed request.',
    });
    expect(accounts.find(account.id)!.healthScore).toBe(100);
  });

  test('no accounts is a 503 the failover can move past', async () => {
    const { pool: accounts } = pool();
    await expect(new KiroExecutor(accounts).execute({ prepared: prepared(), modelSpec: spec })).rejects.toMatchObject({ status: 503 });
  });
});
