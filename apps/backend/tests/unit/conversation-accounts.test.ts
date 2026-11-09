/**
 * A conversation stays with the account that answered it (`core/conversation-accounts.ts`).
 *
 * An upstream's prompt cache belongs to one account. The healthiest-first choice, with the least recently used
 * as the tiebreak, sent each request of a conversation to the next account, and each account wrote the
 * conversation's prefix into a cache of its own: a write where the account before would have charged a read.
 * These tests hold the rule on its own, through Claude Code's manager, and on the path a request takes through
 * each provider that has it, Claude Code and Codex, to the upstream.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProxyConfig } from '@/config/manager';
import type { ProviderExecuteParams } from '@/core/interfaces';
import type { RequestContext } from '@/core/request-context';
import { ClaudeCodeProvider } from '@/providers/claudecode';
import * as manager from '@/providers/claudecode/auth/manager';
import { CodexProvider } from '@/providers/codex';
import * as codex from '@/providers/codex/auth/manager';
import { clearSeeds, seedClaudeCode, seedCodex } from './fixtures/upstream-models';

let dir = '';
const realFetch = globalThis.fetch;

/** A fresh accounts file and a manager reloaded from it, as `claudecode-manager.test.ts` makes one. */
async function freshManager(): Promise<typeof manager> {
  dir = mkdtempSync(join(tmpdir(), 'claude-code-conversation-'));
  process.env.CLAUDE_CODE_ACCOUNTS_FILE = join(dir, 'accounts.json');
  await manager.initManager();
  return manager;
}

beforeAll(async () => {
  // The provider's mappers and the executor's retry budget read the proxy config.
  await loadProxyConfig();
  // A provider's models are its upstream's: these are the ones they listed.
  seedCodex();
  seedClaudeCode();
});

afterAll(() => clearSeeds());

afterEach(() => {
  globalThis.fetch = realFetch;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
  delete process.env.CLAUDE_CODE_ACCOUNTS_FILE;
  delete process.env.CODEX_ACCOUNTS_FILE;
});

/** One request of `conversation` through `provider`, on the wire the router gives it: its session id is the conversation. */
async function ask(
  provider: ClaudeCodeProvider | CodexProvider,
  conversation: string,
  protocol: 'anthropic' | 'openai' = 'anthropic',
): Promise<void> {
  const modelId = provider.getModelRegistry().listModelIds()[0]!;
  const params = {
    protocol,
    body: {
      model: `${provider.id}:${modelId}`,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hello' }],
    },
    resolvedModel: { providerId: provider.id, modelId, raw: `${provider.id}:${modelId}` },
    modelSpec: provider.getModelRegistry().getSpec(modelId)!,
    ctx: { sessionId: conversation, clientId: 'test' } as unknown as RequestContext,
  } as ProviderExecuteParams;
  const response = await provider.execute(params);
  expect(response.status).toBe(200);
  await response.text();
}

/** What an answer does to the account that gave it, as the executor records it. */
async function answered(m: typeof manager, conversation: string, accountId: string): Promise<void> {
  await m.updateAccountUsage(accountId, true);
  m.rememberConversation(conversation, accountId);
}

describe('the account a conversation is given', () => {
  test('its next request goes back to the account that answered it; a new conversation is spread as before', async () => {
    const m = await freshManager();
    const a = await m.addAccount('sk-ant-api03-account-a');
    const b = await m.addAccount('sk-ant-api03-account-b');

    const first = await m.getBestAccount('claude-opus-5', [], 'conversation-1');
    expect(first?.id).toBe(a.id);
    await answered(m, 'conversation-1', a.id);

    // `a` was just used, so the least-recently-used tiebreak alone would now say `b`: the rotation that spent
    // a cache write on every request.
    expect((await m.getBestAccount('claude-opus-5', [], 'conversation-1'))?.id).toBe(a.id);
    expect((await m.getBestAccount('claude-opus-5', [], 'conversation-2'))?.id).toBe(b.id);
    expect((await m.getBestAccount('claude-opus-5'))?.id).toBe(b.id);
  });

  test('it moves when its account cannot answer: cooling, already tried this request, or invalidated', async () => {
    const m = await freshManager();
    const a = await m.addAccount('sk-ant-api03-account-a');
    const b = await m.addAccount('sk-ant-api03-account-b');
    await answered(m, 'conversation-1', a.id);

    expect((await m.getBestAccount('claude-opus-5', [a.id], 'conversation-1'))?.id).toBe(b.id);

    await m.markCooldown(a.id, m.cooldownScope('claude-opus-5'), 60_000);
    expect((await m.getBestAccount('claude-opus-5', [], 'conversation-1'))?.id).toBe(b.id);
    await m.resetAccount(a.id);
    expect((await m.getBestAccount('claude-opus-5', [], 'conversation-1'))?.id).toBe(a.id);

    await m.invalidate(a.id, 'test');
    expect((await m.getBestAccount('claude-opus-5', [], 'conversation-1'))?.id).toBe(b.id);
  });

  test('a removed account gives its conversation up to the next', async () => {
    const m = await freshManager();
    const a = await m.addAccount('sk-ant-api03-account-a');
    const b = await m.addAccount('sk-ant-api03-account-b');
    await answered(m, 'conversation-1', a.id);

    await m.removeAccount(a.id);
    expect((await m.getBestAccount('claude-opus-5', [], 'conversation-1'))?.id).toBe(b.id);
  });

  test('an hour after its last answer it is chosen afresh, since no cache is left to go back to', async () => {
    const m = await freshManager();
    const a = await m.addAccount('sk-ant-api03-account-a');
    const b = await m.addAccount('sk-ant-api03-account-b');
    await m.updateAccountUsage(a.id, true);

    m.rememberConversation('conversation-1', a.id, Date.now() - 61 * 60_000);
    expect((await m.getBestAccount('claude-opus-5', [], 'conversation-1'))?.id).toBe(b.id);

    m.rememberConversation('conversation-1', a.id, Date.now() - 59 * 60_000);
    expect((await m.getBestAccount('claude-opus-5', [], 'conversation-1'))?.id).toBe(a.id);
  });

  test('past ten thousand conversations the one answered longest ago is forgotten, and only it', async () => {
    const m = await freshManager();
    const a = await m.addAccount('sk-ant-api03-account-a');
    const b = await m.addAccount('sk-ant-api03-account-b');
    await m.updateAccountUsage(a.id, true);

    m.rememberConversation('oldest', a.id);
    m.rememberConversation('second', a.id);
    for (let i = 0; i < 9_998; i++) m.rememberConversation(`filler-${i}`, b.id);
    // Answered again: no longer the oldest, so the next one past the bound takes `second` instead.
    m.rememberConversation('oldest', a.id);
    m.rememberConversation('one-too-many', b.id);

    expect((await m.getBestAccount('claude-opus-5', [], 'oldest'))?.id).toBe(a.id);
    expect((await m.getBestAccount('claude-opus-5', [], 'second'))?.id).toBe(b.id);
  });
});

describe('Claude Code, as a request runs', () => {
  /** The upstream: who was asked, by the credential each request carried, and what it answers each one. */
  function upstream(answer: (key: string) => Response = () => message()) {
    const asked: string[] = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const key = (init?.headers as Record<string, string>)['x-api-key'] ?? '';
      asked.push(key);
      return answer(key);
    }) as typeof fetch;
    return asked;
  }

  function message(): Response {
    return new Response(
      JSON.stringify({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }

  test('one conversation is answered by one account, on either wire, and another conversation by the next', async () => {
    const m = await freshManager();
    await m.addAccount('sk-ant-api03-account-a');
    await m.addAccount('sk-ant-api03-account-b');
    const provider = new ClaudeCodeProvider();
    const asked = upstream();

    await ask(provider, 'conversation-1');
    await ask(provider, 'conversation-1');
    await ask(provider, 'conversation-1', 'openai');
    await ask(provider, 'conversation-2');

    expect(asked).toEqual([
      'sk-ant-api03-account-a',
      'sk-ant-api03-account-a',
      'sk-ant-api03-account-a',
      'sk-ant-api03-account-b',
    ]);
  });

  test('a rate limit moves the conversation, and it stays where it was answered once the limit has passed', async () => {
    const m = await freshManager();
    const a = await m.addAccount('sk-ant-api03-account-a');
    await m.addAccount('sk-ant-api03-account-b');
    const provider = new ClaudeCodeProvider();
    let limited = true;
    const asked = upstream((key) => {
      if (key === 'sk-ant-api03-account-a' && limited) {
        limited = false;
        return new Response('{"type":"error","error":{"type":"rate_limit_error"}}', {
          status: 429,
          headers: { 'retry-after': '60' },
        });
      }
      return message();
    });

    await ask(provider, 'conversation-1');
    // The limit is over: `a` can answer again, and is the account used longer ago. The conversation's cache
    // is on `b`.
    await m.resetAccount(a.id);
    await ask(provider, 'conversation-1');

    expect(asked).toEqual(['sk-ant-api03-account-a', 'sk-ant-api03-account-b', 'sk-ant-api03-account-b']);
  });
});

describe('Codex, as a request runs', () => {
  const event = (payload: Record<string, unknown>) => `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`;
  const answer = () =>
    new Response(
      [
        event({ type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } }),
        event({ type: 'response.output_text.delta', output_index: 0, delta: 'ok' }),
        event({ type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }),
      ].join(''),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  const usageLimit = () =>
    new Response(
      event({ type: 'response.failed', response: { id: 'resp_1', status: 'failed', error: { code: 'rate_limit_exceeded', message: 'Rate limit reached.' } } }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  // Past the five days before expiry a credential is renewed ahead of time, a call these tests do not mean to make.
  const TEN_DAYS = 10 * 24 * 3600;

  /** Two Codex sign-ins in a fresh accounts file, and the upstream's answers by the token that asked. */
  async function twoAccounts(reply: (token: string) => Response = () => answer()) {
    dir = mkdtempSync(join(tmpdir(), 'codex-conversation-'));
    process.env.CODEX_ACCOUNTS_FILE = join(dir, 'accounts.json');
    await codex.initManager();
    const one = await codex.addOAuthAccount({ accessToken: 'test-access-one', refreshToken: 'test-refresh-one', expiresInSeconds: TEN_DAYS, label: 'one' });
    await codex.addOAuthAccount({ accessToken: 'test-access-two', refreshToken: 'test-refresh-two', expiresInSeconds: TEN_DAYS, label: 'two' });
    const asked: string[] = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const token = String((init?.headers as Record<string, string>).authorization).replace('Bearer ', '');
      asked.push(token);
      return reply(token);
    }) as unknown as typeof fetch;
    return { asked, one };
  }

  test('one conversation is answered by one account, on either wire, and another conversation by the next', async () => {
    const { asked } = await twoAccounts();
    const provider = new CodexProvider();

    await ask(provider, 'conversation-1', 'openai');
    await ask(provider, 'conversation-1', 'openai');
    await ask(provider, 'conversation-1', 'anthropic');
    await ask(provider, 'conversation-2', 'openai');

    expect(asked).toEqual(['test-access-one', 'test-access-one', 'test-access-one', 'test-access-two']);
  });

  test('a usage limit moves the conversation, and it stays where it was answered once the limit has passed', async () => {
    let limited = true;
    const { asked, one } = await twoAccounts((token) => {
      if (token === 'test-access-one' && limited) {
        limited = false;
        return usageLimit();
      }
      return answer();
    });
    const provider = new CodexProvider();

    await ask(provider, 'conversation-1', 'openai');
    // The limit is over: `one` can answer again, and is the account used longer ago. The conversation's cache
    // is on `two`.
    await codex.resetAccount(one.id);
    await ask(provider, 'conversation-1', 'openai');

    expect(asked).toEqual(['test-access-one', 'test-access-two', 'test-access-two']);
  });
});
