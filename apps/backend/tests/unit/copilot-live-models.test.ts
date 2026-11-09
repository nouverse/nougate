/**
 * Copilot lists the models Copilot offers its account, and only those.
 *
 * The provider reads `GET https://api.githubcopilot.com/models` with the session token a request
 * uses — at start, after an account is added, every six hours — and offers the chat models Copilot's
 * picker shows, whose policy is not `disabled`, that Copilot serves on `/chat/completions`, the one
 * endpoint this provider sends to. No id is written down.
 *
 * The fixture is every entry of the answer a live account gave on 2026-11-09, as Copilot shapes them
 * (terms and vision limits trimmed), plus one admin-disabled entry that answer did not have. The
 * account is a fake held in the manager's memory, and `fetch` is stubbed: nothing reaches GitHub, and
 * nothing here saves the pool, whose file is fixed when its module loads.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAccounts } from '@/providers/copilot/auth/manager';
import type { CopilotAccount } from '@/providers/copilot/auth/types';
import { copilotLiveSpecs, copilotModelRegistry, loadModelSpecOverrides } from '@/providers/copilot/config/model-specs';
import { copilotModelList } from '@/providers/copilot/upstream/models';
import { COPILOT_ANSWER } from './fixtures/upstream-models';

// The list keeps its answer on disk: in a scratch data directory, never the real one.
const modelsHome = mkdtempSync(join(tmpdir(), 'nougate-models-home-'));
const previousModelsHome = process.env.NOUGATE_HOME;
process.env.NOUGATE_HOME = modelsHome;
afterAll(() => {
  if (previousModelsHome === undefined) delete process.env.NOUGATE_HOME;
  else process.env.NOUGATE_HOME = previousModelsHome;
  rmSync(modelsHome, { recursive: true, force: true });
});

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
    ...COPILOT_ANSWER.data,
    // Not in the 2026-11-09 answer: a model an organisation's admin turned off.
    chat('claude-fable-6', 'Claude Fable 6', ['/chat/completions'], { max_output_tokens: 64000 }, { policy: { state: 'disabled', terms: '' } }),
  ],
};

/** The nine the picker showed, served on /chat/completions. */
const OFFERED = [
  'claude-haiku-4.5',
  'claude-haiku-5.5',
  'claude-opus-4.8',
  'claude-opus-5',
  'claude-opus-5.5',
  'claude-sonnet-5',
  'claude-sonnet-5.5',
  'gemini-3.8-flash',
  'gemini-4-argon',
];

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
  test('the chat models its picker shows, with the limits their entries state', async () => {
    hold(account());
    upstream(() => Response.json(LIVE));
    await copilotModelList.refresh();

    expect(copilotModelRegistry.listModelIds()).toEqual(OFFERED);
    const argon = copilotModelRegistry.getSpec('gemini-4-argon')!;
    expect(argon).toMatchObject({ displayName: 'Gemini 4 Argon', upstreamModelId: 'gemini-4-argon', maxOutputTokens: 65536, contextWindow: 200000, pool: 'cli' });
    expect(argon.inputPricePer1M).toBeUndefined();
    expect(copilotModelRegistry.getSpec('claude-opus-4.8')).toMatchObject({ maxOutputTokens: 64000, contextWindow: 200000 });
    // Copilot lists Opus 5 under its own id: it is sent as that, not as another model.
    expect(copilotModelRegistry.getSpec('claude-opus-5')?.upstreamModelId).toBe('claude-opus-5');
    // Whatever the case a client writes an id in.
    expect(copilotModelRegistry.getSpec('Gemini-4-Argon')?.modelId).toBe('gemini-4-argon');
    expect(copilotModelRegistry.getSpec(' CLAUDE-OPUS-5 ')?.modelId).toBe('claude-opus-5');
  });

  test('none served only on /responses, none its picker hides, none that is not chat, none an admin disabled', async () => {
    hold(account());
    upstream(() => Response.json(LIVE));
    await copilotModelList.refresh();

    for (const left of ['gpt-6-luna', 'gpt-5.6-luna', 'gpt-6.1-sol', 'grok-4.7', 'mai-code-1.1-flash', 'gpt-5.4-nano', 'gpt-4o', 'gpt-4o-2024-11-20', 'gpt-6-luna-decisions', 'text-embedding-3-small', 'claude-fable-6']) {
      expect(copilotModelRegistry.listModelIds()).not.toContain(left);
    }
  });

  test('nothing before Copilot has answered: no id is written down', () => {
    expect(copilotModelRegistry.listModelIds()).toEqual([]);
    expect(copilotModelRegistry.liveModelIds()).toEqual([]);
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
    expect(copilotModelRegistry.liveModelIds()).toEqual(OFFERED);
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

describe("an operator's override file", () => {
  const file = () => join(modelsHome, 'data', 'providers', 'copilot', 'model-specs.json');

  afterEach(async () => {
    rmSync(file(), { force: true });
    await loadModelSpecOverrides();
  });

  test("is laid over the upstream's spec of a model, and makes a model the upstream does not list", async () => {
    mkdirSync(join(modelsHome, 'data', 'providers', 'copilot'), { recursive: true });
    writeFileSync(file(), JSON.stringify({ 'Claude-Sonnet-5': { timeoutMs: 123_456 }, 'my-own-model': { displayName: 'My Own' } }));
    await loadModelSpecOverrides();
    copilotModelRegistry.mergeLive(copilotLiveSpecs(COPILOT_ANSWER.data));

    // Copilot's own facts stay, the operator's change is on top.
    expect(copilotModelRegistry.getSpec('claude-sonnet-5')).toMatchObject({ maxOutputTokens: 64000, contextWindow: 200000, timeoutMs: 123_456 });
    expect(copilotModelRegistry.getSpec('my-own-model')).toMatchObject({ modelId: 'my-own-model', displayName: 'My Own', pool: 'cli' });
    expect(copilotModelRegistry.listModelIds()).toContain('my-own-model');
  });

  test('read again, it holds only what the file now has', async () => {
    mkdirSync(join(modelsHome, 'data', 'providers', 'copilot'), { recursive: true });
    writeFileSync(file(), JSON.stringify({ 'my-own-model': { displayName: 'My Own' } }));
    await loadModelSpecOverrides();
    writeFileSync(file(), JSON.stringify({}));
    await loadModelSpecOverrides();

    expect(copilotModelRegistry.listModelIds()).not.toContain('my-own-model');
  });
});
