/**
 * A failure Codex names inside a 200 stream reaches the client as a failure (nouride-releases#14).
 *
 * Codex reports a request it will not finish — a window exceeded, a usage limit, a prompt it flags, its own server
 * error — as `response.failed` (or an `error` event) inside a stream that began with 200 OK. The translation kept the
 * message in a field nothing read and closed the stream with `finish_reason: "stop"`: a clean, empty reply. A Nouride
 * agent on `codex:gpt-5.6-luna` answered "I did not manage to produce an answer" to every message, with nothing in
 * either log saying why.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderResponseError } from '@/core/upstream-errors';
import type { IProvider } from '@/core/interfaces';
import { resolveModel } from '@/core/model-resolver';
import { registerProvider, unregisterProvider } from '@/core/registry';
import { loadProxyConfig } from '@/config/manager';
import { OpenAIProtocolHandler } from '@/protocols/openai/handler';
import { AnthropicProtocolHandler } from '@/protocols/anthropic/handler';
import { createOpenAIToAnthropicStreamTransformer } from '@/core/mappers/anthropic-to-openai';
import { addOAuthAccount, getAccounts, initManager } from '@/providers/codex/auth/manager';
import {
  createResponsesToOpenAIStreamTransformer,
  finalizeResponsesToOpenAIResponse,
} from '@/providers/codex/mappers/openai-to-responses';
import { CodexExecutor } from '@/providers/codex/upstream/executor';
import { peekSseTransientError } from '@/providers/codex/upstream/stream';
import { getModelSpec } from '@/providers/codex/config/model-specs';

const event = (payload: Record<string, unknown>) => `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`;
const created = event({ type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } });
const failed = (code: string, message: string) =>
  event({ type: 'response.failed', response: { id: 'resp_1', status: 'failed', error: { code, message } } });
const text = (delta: string) => event({ type: 'response.output_text.delta', output_index: 0, delta });
const completed = event({ type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } });

const sse = (...parts: string[]) =>
  new Response(parts.join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  return await new Response(stream).text();
}

const chunks = (out: string) =>
  out
    .split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice(6)));

describe('a failure before the answer began', () => {
  test('the peek finds it, with its code and words — never handed on as a body to read', async () => {
    const peek = await peekSseTransientError(sse(created, failed('context_length_exceeded', 'Your input exceeds the context window of this model.')));
    expect(peek.failure).toEqual({ code: 'context_length_exceeded', message: 'Your input exceeds the context window of this model.' });
    expect(peek.replacementBody).toBeNull();
  });

  test('an `error` event is one too', async () => {
    const peek = await peekSseTransientError(sse(created, event({ type: 'error', code: 'rate_limit_exceeded', message: 'Rate limit reached. Please try again in 2s.' })));
    expect(peek.failure).toEqual({ code: 'rate_limit_exceeded', message: 'Rate limit reached. Please try again in 2s.' });
  });

  test('a stream that is answering is handed on whole, whatever comes later in it', async () => {
    const peek = await peekSseTransientError(sse(created, text('Hel'), failed('server_error', 'An error occurred.')));
    expect(peek.failure).toBeUndefined();
    expect(await readAll(peek.replacementBody!)).toContain('An error occurred.');
  });
});

describe('a failure after the answer began', () => {
  const translate = async (...parts: string[]) =>
    await readAll(sse(...parts).body!.pipeThrough(createResponsesToOpenAIStreamTransformer('codex:gpt-5.6-luna')));

  test('the stream ends on an `error` chunk, not on a clean finish', async () => {
    const out = chunks(await translate(created, text('Hel'), failed('server_error', 'An error occurred while processing your request.')));
    expect(out.map((c) => c.choices?.[0]?.delta?.content).filter(Boolean)).toEqual(['Hel']);
    expect(out.at(-1)).toEqual({ error: { message: 'An error occurred while processing your request.', type: 'server_error', code: 'server_error' } });
    expect(out.some((c) => c.choices?.[0]?.finish_reason === 'stop')).toBe(false);
  });

  test('an answer cut at the output limit says `length`, with its usage', async () => {
    const incomplete = event({
      type: 'response.incomplete',
      response: { incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 10, output_tokens: 64, total_tokens: 74 } },
    });
    const out = chunks(await translate(created, text('Hel'), incomplete));
    expect(out.at(-1).choices[0].finish_reason).toBe('length');
    expect(out.at(-1).usage).toMatchObject({ prompt_tokens: 10, completion_tokens: 64 });
  });

  test('a clean answer still finishes as it did', async () => {
    const out = chunks(await translate(created, text('OK'), completed));
    expect(out.at(-1).choices[0].finish_reason).toBe('stop');
    expect(out.at(-1).usage).toMatchObject({ prompt_tokens: 10, completion_tokens: 2 });
  });

  test('without a stream to keep, the failure is the answer: its status, never an empty 200', async () => {
    const thrown = await finalizeResponsesToOpenAIResponse(sse(created, text('Hel'), failed('context_length_exceeded', 'Your input exceeds the context window of this model.')), 'codex:gpt-5.6-luna').catch((err: unknown) => err);
    expect(thrown).toBeInstanceOf(ProviderResponseError);
    expect(thrown).toMatchObject({ status: 400, clientCode: 'context_length_exceeded' });
  });

  test('an Anthropic client gets an `error` event, and the message is not closed as a finished one', async () => {
    const openai = sse(
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"error":{"message":"An error occurred while processing your request.","type":"server_error","code":"server_error"}}\n\n',
      'data: [DONE]\n\n',
    );
    const out = await readAll(openai.body!.pipeThrough(createOpenAIToAnthropicStreamTransformer('codex:gpt-5.6-luna', 'msg_t') as any));
    expect(out).toContain('event: error\ndata: {"type":"error","error":{"type":"api_error","message":"An error occurred while processing your request."}}');
    expect(out).not.toContain('message_stop');
  });
});

describe('the executor', () => {
  const home = mkdtempSync(join(tmpdir(), 'nougate-codex-failure-'));
  const previousHome = process.env.NOUGATE_HOME;
  const realFetch = globalThis.fetch;
  const spec = getModelSpec('gpt-5.6-luna')!;
  let asked: string[] = [];
  // Past the five days before expiry a credential is renewed ahead of time — a call this test does not mean to make.
  const TEN_DAYS = 10 * 24 * 3600;

  beforeAll(async () => {
    process.env.NOUGATE_HOME = home;
    await initManager();
    await addOAuthAccount({ accessToken: 'test-access-one', refreshToken: 'test-refresh-one', expiresInSeconds: TEN_DAYS, label: 'one' });
    await addOAuthAccount({ accessToken: 'test-access-two', refreshToken: 'test-refresh-two', expiresInSeconds: TEN_DAYS, label: 'two' });
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    asked = [];
  });
  afterAll(() => {
    if (previousHome === undefined) delete process.env.NOUGATE_HOME;
    else process.env.NOUGATE_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  /** The upstream's answers in the order it is asked, and which credential asked each time. */
  const upstream = (...answers: (() => Response)[]) => {
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      asked.push(String((init.headers as Record<string, string>).authorization).replace('Bearer ', ''));
      return answers[asked.length - 1]!();
    }) as unknown as typeof fetch;
  };

  test('a window exceeded is the request\'s fault: answered as a 400 at once, no other credential asked', async () => {
    upstream(() => sse(created, failed('context_length_exceeded', 'Your input exceeds the context window of this model.')));
    const thrown = await new CodexExecutor().execute({ body: { input: [] }, modelSpec: spec }).catch((err: unknown) => err);
    expect(thrown).toBeInstanceOf(ProviderResponseError);
    expect(thrown).toMatchObject({ status: 400, clientCode: 'context_length_exceeded', message: 'Your input exceeds the context window of this model.' });
    expect(asked).toHaveLength(1);
  });

  test('a usage limit is the credential\'s: it sits out, and the next one answers', async () => {
    upstream(
      () => sse(created, failed('rate_limit_exceeded', 'Rate limit reached. Please try again in 20s.')),
      () => sse(created, text('OK'), completed),
    );
    const result = await new CodexExecutor().execute({ body: { input: [] }, modelSpec: spec });
    expect(asked).toHaveLength(2);
    expect(asked[1]).not.toBe(asked[0]);
    expect(await result.response.text()).toContain('OK');
    const cooled = getAccounts().find((account) => account.accessToken === asked[0])!;
    expect(cooled.cooldowns?.['gpt-5.6-luna']).toBeGreaterThan(Date.now());
  });
});

/**
 * The label of an error a provider names follows its status. A client reads the label first: a 502 labelled
 * `invalid_request_error` read in Nouride as a request built wrong — "Something is wrong with how I am building
 * requests", no retry — for Codex's own server error (found end to end, 2026-11-02).
 */
describe('an error a provider names is labelled by its status', () => {
  const failingWith = (status: number, clientCode: string): IProvider => ({
    id: 'fixture',
    displayName: 'fixture',
    init: async () => {},
    getJitterConfig: () => ({ jitterEnabled: false, jitterMinMs: 0, jitterMaxMs: 0 }),
    getBestAccount: async () => null,
    updateAccountUsage: async () => {},
    getAccounts: () => [],
    getModelRegistry: () => ({ getSpec: (modelId) => ({ modelId, pool: 'sandbox', isThinking: false, maxOutputTokens: 4096 }), listModelIds: () => ['m'] }),
    getSupportedModels: () => ['m'],
    execute: async () => {
      throw new ProviderResponseError('An error occurred while processing your request.', { status, clientCode });
    },
  });

  const ask = async (handler: OpenAIProtocolHandler | AnthropicProtocolHandler, path: string, status: number) => {
    await loadProxyConfig();
    const provider = failingWith(status, 'server_error');
    registerProvider(provider);
    try {
      const req = new Request(`http://localhost:3000${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'fixture:m', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }),
      });
      const response = await handler.handle({ req, url: new URL(req.url), protocol: path.startsWith('/openai') ? 'openai' : 'anthropic', resolvedModel: resolveModel('fixture:m'), provider, sessionId: 's', clientId: 'c' });
      return { status: response.status, body: (await response.json()) as any };
    } finally {
      unregisterProvider('fixture');
    }
  };

  test('an OpenAI client reads a 502 as the server\'s, a 429 as a rate limit, a 400 as its request', async () => {
    const openai = new OpenAIProtocolHandler();
    expect(await ask(openai, '/openai/v1/chat/completions', 502)).toMatchObject({ status: 502, body: { error: { type: 'server_error' } } });
    expect((await ask(openai, '/openai/v1/chat/completions', 429)).body.error.type).toBe('rate_limit_error');
    expect((await ask(openai, '/openai/v1/chat/completions', 400)).body.error.type).toBe('invalid_request_error');
  });

  test('an Anthropic client reads a 502 as `api_error`', async () => {
    const anthropic = new AnthropicProtocolHandler();
    expect(await ask(anthropic, '/anthropic/v1/messages', 502)).toMatchObject({ status: 502, body: { type: 'error', error: { type: 'api_error' } } });
    expect((await ask(anthropic, '/anthropic/v1/messages', 400)).body.error.type).toBe('invalid_request_error');
  });
});
