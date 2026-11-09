/**
 * Copilot lists the models Copilot offers its account, not only the ones written down.
 *
 * The provider reads `GET https://api.githubcopilot.com/models` with the session token a request
 * uses — at start, after an account is added, every six hours — and offers the chat models Copilot's
 * picker shows, whose policy is not `disabled`, that Copilot serves on `/chat/completions`, the one
 * endpoint this provider sends to. A written model keeps its spec.
 *
 * The fixture is entries from the answer a live account gave on 2026-11-09, as Copilot shapes them
 * (terms and vision limits trimmed), plus one admin-disabled entry that answer did not have. The
 * account is a fake held in the manager's memory, and `fetch` is stubbed: nothing reaches GitHub, and
 * nothing here saves the pool, whose file is fixed when its module loads.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAccounts } from '@/providers/copilot/auth/manager';
import type { CopilotAccount } from '@/providers/copilot/auth/types';
import { copilotLiveSpecs, copilotModelRegistry, servedOnChatCompletions } from '@/providers/copilot/config/model-specs';
import { copilotModelList } from '@/providers/copilot/upstream/models';

const chat = (
  id: string,
  name: string,
  endpoints: string[] | undefined,
  limits: Record<string, number>,
  extra: Record<string, unknown> = {},
) => ({
  id,
  name,
  object: 'model',
  vendor: 'test-vendor',
  version: id,
  preview: false,
  model_picker_enabled: true,
  model_picker_category: 'versatile',
  policy: { state: 'enabled', terms: 'Enable access to the latest model.' },
  capabilities: { type: 'chat', family: id, limits, supports: { streaming: true, tool_calls: true } },
  ...(endpoints ? { supported_endpoints: endpoints } : {}),
  ...extra,
});

const LIVE = {
  object: 'list',
  data: [
    chat('claude-opus-4.8', 'Claude Opus 4.8', ['/v1/messages', '/chat/completions'], { max_context_window_tokens: 264000, max_non_streaming_output_tokens: 16000, max_output_tokens: 64000, max_prompt_tokens: 200000 }),
    chat('claude-opus-5', 'Claude Opus 5', ['/v1/messages', '/chat/completions'], { max_context_window_tokens: 264000, max_output_tokens: 64000, max_prompt_tokens: 200000 }),
    chat('gemini-3.8-flash', 'Gemini 3.8 Flash', ['/chat/completions'], { max_context_window_tokens: 265536, max_output_tokens: 65536, max_prompt_tokens: 200000 }),
    chat('gemini-4-argon', 'Gemini 4 Argon', ['/chat/completions'], { max_context_window_tokens: 265536, max_non_streaming_output_tokens: 32768, max_output_tokens: 65536, max_prompt_tokens: 200000 }),
    chat('gpt-6-luna', 'GPT-6 Luna', ['/responses', 'ws:/responses'], { max_context_window_tokens: 400000, max_output_tokens: 128000, max_prompt_tokens: 272000 }),
    chat('gpt-6.1-sol', 'GPT-6.1 Sol', ['/responses', 'ws:/responses'], { max_context_window_tokens: 400000, max_output_tokens: 128000, max_prompt_tokens: 272000 }),
    chat('grok-4.7', 'Grok 4.7', ['/responses'], { max_context_window_tokens: 328000, max_output_tokens: 128000, max_prompt_tokens: 200000 }, { policy: undefined }),
    chat('gpt-5.4-nano', 'GPT-5.4 nano', ['/responses', 'ws:/responses'], { max_output_tokens: 128000 }, { model_picker_enabled: false }),
    chat('gpt-4o-2024-11-20', 'GPT-4o', undefined, { max_output_tokens: 16384, max_prompt_tokens: 64000 }, { model_picker_enabled: false }),
    {
      id: 'gpt-6-luna-decisions',
      name: 'GPT 6 Luna Decisions',
      object: 'model',
      model_picker_enabled: false,
      capabilities: { type: 'decisions', family: 'gpt-6-luna', limits: { max_context_window_tokens: 1000000, max_prompt_tokens: 872000 }, supports: {} },
      supported_endpoints: ['/v1/decisions'],
    },
    {
      id: 'text-embedding-3-small',
      name: 'Embedding V3 small',
      object: 'model',
      model_picker_enabled: false,
      capabilities: { type: 'embeddings', family: 'text-embedding-3-small', limits: { max_inputs: 512 }, supports: { dimensions: true } },
    },
    // Not in the 2026-11-09 answer: a model an organisation's admin turned off.
    chat('claude-fable-6', 'Claude Fable 6', ['/chat/completions'], { max_output_tokens: 64000 }, { policy: { state: 'disabled', terms: '' } }),
  ],
};

/**
 * Every model the live account's answer listed on 2026-11-09, with the endpoints Copilot said serve it
 * (`supported_endpoints`; `undefined` where the entry named none). A request to `copilot:gpt-6-luna`
 * and one to `copilot:gpt-5.6-luna` on `/chat/completions` that day were each refused with 400
 * `unsupported_api_for_model`.
 */
const CHAT = ['/v1/messages', '/chat/completions'];
const RESPONSES = ['/responses', 'ws:/responses'];
const ENDPOINTS_2026_11_09: Record<string, string[] | undefined> = {
  'claude-haiku-5.5': CHAT, 'claude-opus-4.8': CHAT, 'claude-opus-5.5': CHAT, 'claude-opus-5': CHAT,
  'claude-sonnet-5.5': CHAT, 'claude-sonnet-5': CHAT, 'claude-haiku-4.5': ['/chat/completions', '/v1/messages'],
  'gemini-3.8-flash': ['/chat/completions'], 'gemini-4-argon': ['/chat/completions'],
  'gpt-5.3-codex': RESPONSES, 'gpt-5.4-nano': RESPONSES, 'gpt-5.6-luna': RESPONSES, 'gpt-5.6-sol': RESPONSES,
  'gpt-5.6-terra': RESPONSES, 'gpt-6.1-sol': RESPONSES, 'gpt-6.1-terra': RESPONSES, 'gpt-6-astra': RESPONSES,
  'gpt-6-luna': RESPONSES, 'gpt-6-sol': RESPONSES, 'mai-code-1.1-flash': RESPONSES,
  'grok-4.6': ['/responses'], 'grok-4.7': ['/responses'], 'gpt-6-luna-decisions': ['/v1/decisions'],
  'gpt-4o-mini-2024-07-18': undefined, 'gpt-4o-2024-11-20': undefined, 'gpt-4o-2024-08-06': undefined,
  'text-embedding-3-small': undefined, 'text-embedding-3-small-inference': undefined,
  'gpt-4.1-2025-04-14': undefined, 'gpt-3.5-turbo-0613': undefined, 'gpt-4': undefined, 'gpt-4-0613': undefined,
  'gpt-4-0125-preview': undefined, 'gpt-4o-2024-05-13': undefined, 'gpt-4-o-preview': undefined, 'gpt-4.1': undefined,
  'gpt-3.5-turbo': undefined, 'gpt-4o-mini': undefined, 'gpt-4o': undefined, 'text-embedding-ada-002': undefined,
};

const HOUR = 3_600_000;
const realFetch = globalThis.fetch;
const realLog = console.log;
const realWarn = console.warn;
let accountsBefore: CopilotAccount[] = [];
let asked: Array<{ url: string; method?: string; headers: Headers }> = [];

/** An account whose session token is still fresh, unless `sessionTokenExpiresAt` says otherwise. */
function account(overrides: Partial<CopilotAccount> = {}): CopilotAccount {
  return {
    id: 'copilot-test',
    providerId: 'copilot',
    personalToken: 'test-personal-token',
    sessionToken: 'test-session-token',
    sessionTokenExpiresAt: Date.now() + HOUR,
    healthScore: 100,
    lastUsed: 0,
    status: 'active',
    ...overrides,
  };
}

/** Put these accounts, and only these, in the manager's memory. Nothing is written. */
function hold(...accounts: CopilotAccount[]): void {
  const held = getAccounts();
  held.splice(0, held.length, ...accounts);
}

/** The upstream answers each call with the next of `answers`. */
function upstream(...answers: Array<() => Response>) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    asked.push({ url: String(input), method: init?.method, headers: new Headers(init?.headers) });
    return answers[asked.length - 1]!();
  }) as typeof fetch;
}

beforeAll(() => {
  accountsBefore = [...getAccounts()];
  console.log = () => {};
  console.warn = () => {};
});

afterEach(() => {
  globalThis.fetch = realFetch;
  asked = [];
  hold();
  copilotModelRegistry.mergeLive([]);
});

afterAll(() => {
  hold(...accountsBefore);
  console.log = realLog;
  console.warn = realWarn;
});

describe('the list Copilot is asked for', () => {
  test("is /models, with the account's session token and the headers a request carries", async () => {
    hold(account());
    upstream(() => Response.json(LIVE));
    await copilotModelList.refresh();

    expect(asked).toHaveLength(1);
    expect(asked[0]!.url).toBe('https://api.githubcopilot.com/models');
    expect(asked[0]!.method).toBe('GET');
    expect(asked[0]!.headers.get('authorization')).toBe('Bearer test-session-token');
    expect(asked[0]!.headers.get('copilot-integration-id')).toBe('vscode-chat');
    expect(asked[0]!.headers.get('editor-version')).toStartWith('vscode/');
    expect(asked[0]!.headers.get('content-type')).toBeNull();
  });

  test('a session token past its time is exchanged first, for the account’s GitHub token', async () => {
    hold(account({ sessionToken: 'test-session-old', sessionTokenExpiresAt: Date.now() - 1 }));
    upstream(
      () => Response.json({ token: 'test-session-new', expires_at: Math.floor((Date.now() + HOUR) / 1000) }),
      () => Response.json(LIVE),
    );
    await copilotModelList.refresh();

    expect(asked.map((call) => call.url)).toEqual(['https://api.github.com/copilot_internal/v2/token', 'https://api.githubcopilot.com/models']);
    expect(asked[0]!.headers.get('authorization')).toBe('Bearer test-personal-token');
    expect(asked[1]!.headers.get('authorization')).toBe('Bearer test-session-new');
  });

  test('of no account Copilot marked invalid, and of none at all', async () => {
    upstream(() => Response.json(LIVE));
    await copilotModelList.refresh();
    hold(account({ status: 'invalid', invalidatedAt: Date.now() }));
    await copilotModelList.refresh();

    expect(asked).toHaveLength(0);
  });
});

describe('what Copilot then lists', () => {
  test('the chat models its picker shows that the written list lacks, with the limits their entries state', async () => {
    hold(account());
    upstream(() => Response.json(LIVE));
    await copilotModelList.refresh();

    expect(copilotModelRegistry.liveModelIds()).toEqual(['claude-opus-4.8', 'gemini-4-argon']);
    const argon = copilotModelRegistry.getSpec('gemini-4-argon')!;
    expect(argon).toMatchObject({ displayName: 'Gemini 4 Argon', upstreamModelId: 'gemini-4-argon', maxOutputTokens: 65536, contextWindow: 200000, pool: 'cli' });
    expect(argon.inputPricePer1M).toBeUndefined();
    expect(copilotModelRegistry.getSpec('claude-opus-4.8')).toMatchObject({ maxOutputTokens: 64000, contextWindow: 200000 });
    // Looked up as a written one is: whatever the case a client writes it in.
    expect(copilotModelRegistry.getSpec('Gemini-4-Argon')?.modelId).toBe('gemini-4-argon');
    expect(copilotModelRegistry.getSpec(' CLAUDE-OPUS-5 ')?.upstreamModelId).toBe('claude-opus-4.5');
  });

  test('none served only on /responses, none its picker hides, none that is not chat, none an admin disabled', async () => {
    hold(account());
    upstream(() => Response.json(LIVE));
    await copilotModelList.refresh();

    for (const left of ['gpt-6-luna', 'gpt-6.1-sol', 'grok-4.7', 'gpt-5.4-nano', 'gpt-4o-2024-11-20', 'gpt-6-luna-decisions', 'text-embedding-3-small', 'claude-fable-6']) {
      expect(copilotModelRegistry.listModelIds()).not.toContain(left);
    }
  });

  test('a written model keeps its spec', async () => {
    const written = copilotModelRegistry.getSpec('claude-opus-5');
    hold(account());
    upstream(() => Response.json(LIVE));
    await copilotModelList.refresh();

    expect(copilotModelRegistry.getSpec('claude-opus-5')).toEqual(written);
    expect(written).toMatchObject({ upstreamModelId: 'claude-opus-4.5', maxOutputTokens: 8192 });
    expect(written?.contextWindow).toBeUndefined();
  });

  test('a failed answer, a failed exchange, or an answer with no list keeps the last list', async () => {
    hold(account());
    upstream(
      () => Response.json(LIVE),
      () => new Response('{"message":"Bad credentials"}', { status: 500 }),
      () => Response.json({ object: 'list' }),
    );
    await copilotModelList.refresh();
    await copilotModelList.refresh();
    await copilotModelList.refresh();

    hold(account({ sessionTokenExpiresAt: Date.now() - 1 }));
    const before = asked.length;
    upstream(() => new Response('{"message":"Bad credentials"}', { status: 401 }));
    asked = [];
    await copilotModelList.refresh();

    expect(before).toBe(3);
    expect(asked.map((call) => call.url)).toEqual(['https://api.github.com/copilot_internal/v2/token']);
    expect(copilotModelRegistry.liveModelIds()).toEqual(['claude-opus-4.8', 'gemini-4-argon']);
  });
});

describe('the written list', () => {
  test('holds only models Copilot serves on /chat/completions, by the rule the live list follows', () => {
    const live = new Set(copilotModelRegistry.liveModelIds());
    const written = copilotModelRegistry.listModelIds().filter((id) => !live.has(id));
    const judged = written.filter((id) => Object.hasOwn(ENDPOINTS_2026_11_09, id));

    // Most written models were in that answer; the rest (Fable) were not listed for the account.
    expect(judged.length).toBeGreaterThanOrEqual(9);
    const refused = judged.filter((id) => !servedOnChatCompletions({ supported_endpoints: ENDPOINTS_2026_11_09[id] }));
    expect(refused).toEqual([]);
  });

  test('no longer offers the GPT-5.6 and GPT-6 models Copilot serves only on /responses', () => {
    for (const id of ['gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-6-astra', 'gpt-6-luna', 'gpt-6-sol', 'gpt-6-terra']) {
      expect(copilotModelRegistry.getSpec(id)).toBeNull();
    }
  });
});

describe('copilotLiveSpecs', () => {
  test('a model that is not chat is left out even where the picker shows it', () => {
    const embeddings = chat('picker-embeddings', 'Embeddings', ['/embeddings'], {});
    embeddings.capabilities.type = 'embeddings';
    const anywhere = { ...embeddings, supported_endpoints: undefined };
    expect(copilotLiveSpecs([embeddings, anywhere])).toEqual([]);
  });


  test('an entry that names no endpoints is the older kind, served on /chat/completions; an unstated limit is the default', () => {
    const specs = copilotLiveSpecs([chat('older-chat', 'Older Chat', undefined, {})]);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ modelId: 'older-chat', maxOutputTokens: 8192 });
    expect(specs[0]!.contextWindow).toBeUndefined();
  });
});

describe('an account added', () => {
  // Adding one saves the pool to a file fixed when its module loads, which a test must not write, so
  // the two paths are read rather than run: each asks for the list once the account is stored.
  test('by a pasted token or a device login, has the list asked for once it is stored', () => {
    const source = readFileSync(join(import.meta.dir, '../../src/providers/copilot/index.ts'), 'utf8');
    const stored = source.split('await addCopilotAccount(account);').slice(1);
    expect(stored).toHaveLength(2);
    for (const after of stored) {
      expect(after.trimStart()).toStartWith('void copilotModelList.refresh();');
    }
  });
});
