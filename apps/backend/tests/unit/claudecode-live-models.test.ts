/**
 * Claude Code lists the models Anthropic lists for its credential, and only those.
 *
 * The provider reads `GET /v1/models` — at start, after an account is added, every six hours — with
 * the credential a request uses: on the subscription login, `Bearer` with the `oauth-2025-04-20` gate.
 * No id is written down. Anthropic lists older models only by a dated snapshot
 * (`claude-haiku-4-5-20251001`); its undated id still reaches it, as Anthropic answers that id too.
 *
 * The fixture is the answer a live subscription login gave on 2026-11-09, its fields as Anthropic
 * sends them (capabilities left out), split into two pages to walk the paging. The accounts are
 * fakes in a scratch file, and `fetch` is stubbed: nothing reaches Anthropic.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as manager from '@/providers/claudecode/auth/manager';
import { claudeCodeModelList } from '@/providers/claudecode/api/models';
import { claudeCodeModelRegistry, claudeLiveSpecs, type ClaudeListedModel } from '@/providers/claudecode/config/model-specs';
import { ClaudeCodeProvider } from '@/providers/claudecode';
import { CLAUDE_ANSWER } from './fixtures/upstream-models';

// The list keeps its answer on disk: in a scratch data directory, never the real one.
const modelsHome = mkdtempSync(join(tmpdir(), 'nougate-models-home-'));
const previousModelsHome = process.env.NOUGATE_HOME;
process.env.NOUGATE_HOME = modelsHome;
afterAll(() => {
  if (previousModelsHome === undefined) delete process.env.NOUGATE_HOME;
  else process.env.NOUGATE_HOME = previousModelsHome;
  rmSync(modelsHome, { recursive: true, force: true });
});

const LIVE = CLAUDE_ANSWER as Array<ClaudeListedModel & { id: string }>;
const ALL = LIVE.map((model) => model.id).sort();

/** The same list in two pages, as `has_more` and `last_id` page it. */
const page = (models: typeof LIVE, has_more: boolean) =>
  Response.json({ data: models, has_more, first_id: models[0]!.id, last_id: models.at(-1)!.id });
const FIRST_PAGE = () => page(LIVE.slice(0, 11), true);
const SECOND_PAGE = () => page(LIVE.slice(11), false);

const realFetch = globalThis.fetch;
const realLog = console.log;
const realWarn = console.warn;
let dir = '';
let asked: Array<{ url: string; method?: string; headers: Headers }> = [];

/** The upstream answers each call with the next of `answers`. */
function upstream(...answers: Array<() => Response>) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    asked.push({ url: String(input), method: init?.method, headers: new Headers(init?.headers) });
    return answers[asked.length - 1]!();
  }) as typeof fetch;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nougate-claudecode-models-'));
  process.env.CLAUDE_CODE_ACCOUNTS_FILE = join(dir, 'accounts.json');
  await manager.initManager();
  console.log = () => {};
  console.warn = () => {};
});

afterEach(() => {
  globalThis.fetch = realFetch;
  console.log = realLog;
  console.warn = realWarn;
  asked = [];
  claudeCodeModelRegistry.mergeLive([]);
  rmSync(dir, { recursive: true, force: true });
  delete process.env.CLAUDE_CODE_ACCOUNTS_FILE;
});

afterAll(async () => {
  // Leave the manager holding no account, as a test file that loads none expects.
  const empty = mkdtempSync(join(tmpdir(), 'nougate-claudecode-models-'));
  process.env.CLAUDE_CODE_ACCOUNTS_FILE = join(empty, 'accounts.json');
  await manager.initManager();
  delete process.env.CLAUDE_CODE_ACCOUNTS_FILE;
  rmSync(empty, { recursive: true, force: true });
});

/** Wait for `done`, which a background refresh makes true, for up to a second. */
async function until(done: () => boolean): Promise<void> {
  for (let waited = 0; waited < 1_000 && !done(); waited += 5) await Bun.sleep(5);
}

/** A subscription login whose token needs no renewal for a day. */
const subscription = () =>
  manager.addOAuthAccount({ accessToken: 'test-oauth-access', refreshToken: 'test-oauth-refresh', expiresInSeconds: 24 * 3600, label: 'sub' });

describe('the list Anthropic is asked for', () => {
  test('every page of /v1/models, with the subscription login on Bearer and its gate', async () => {
    await subscription();
    upstream(FIRST_PAGE, SECOND_PAGE);
    await claudeCodeModelList.refresh();

    expect(asked.map((call) => call.url)).toEqual([
      'https://api.anthropic.com/v1/models?limit=100',
      'https://api.anthropic.com/v1/models?limit=100&after_id=claude-opus-4-6',
    ]);
    for (const call of asked) {
      expect(call.method).toBe('GET');
      expect(call.headers.get('authorization')).toBe('Bearer test-oauth-access');
      expect(call.headers.get('anthropic-beta')).toContain('oauth-2025-04-20');
      expect(call.headers.get('anthropic-version')).toBe('2023-06-01');
      expect(call.headers.get('user-agent')).toStartWith('claude-cli/');
      expect(call.headers.get('x-api-key')).toBeNull();
    }
  });

  test('a token near its end is renewed first, as a request would renew it, and the list asked with the new one', async () => {
    // An hour left of a token renewed four hours ahead: what the six-hour timer finds on an idle gateway.
    await manager.addOAuthAccount({ accessToken: 'test-oauth-old', refreshToken: 'test-oauth-refresh-near', expiresInSeconds: 3600, label: 'near' });
    upstream(
      () => Response.json({ access_token: 'test-oauth-renewed', refresh_token: 'test-oauth-refresh-next', expires_in: 28_800 }),
      () => page(LIVE, false),
    );
    await claudeCodeModelList.refresh();

    expect(asked.map((call) => `${call.method} ${call.url}`)).toEqual([
      'POST https://api.anthropic.com/v1/oauth/token',
      'GET https://api.anthropic.com/v1/models?limit=100',
    ]);
    expect(asked[1]!.headers.get('authorization')).toBe('Bearer test-oauth-renewed');
  });

  test('an API key goes on x-api-key, with no CLI identity', async () => {
    await manager.addAccount('sk-ant-api03-test-key');
    upstream(() => page(LIVE, false));
    await claudeCodeModelList.refresh();

    expect(asked).toHaveLength(1);
    expect(asked[0]!.headers.get('x-api-key')).toBe('sk-ant-api03-test-key');
    expect(asked[0]!.headers.get('authorization')).toBeNull();
    expect(asked[0]!.headers.get('user-agent')).not.toStartWith('claude-cli/');
  });

  test('is asked again once an account is added, without waiting for the timer', async () => {
    upstream(() => page(LIVE, false));
    await new ClaudeCodeProvider().addAccount({ apiKey: 'sk-ant-api03-added-key' });
    await until(() => claudeCodeModelRegistry.liveModelIds().length > 0);

    expect(asked.map((call) => call.url)).toEqual(['https://api.anthropic.com/v1/models?limit=100']);
    expect(asked[0]!.headers.get('x-api-key')).toBe('sk-ant-api03-added-key');
    expect(claudeCodeModelRegistry.listModelIds()).toContain('claude-opus-4-5-20251101');
  });
});

describe('what Claude Code then lists', () => {
  test('every model Anthropic lists, with the limits its list states and no price', async () => {
    await subscription();
    upstream(FIRST_PAGE, SECOND_PAGE);
    await claudeCodeModelList.refresh();

    expect(claudeCodeModelRegistry.listModelIds()).toEqual(ALL);
    const spec = claudeCodeModelRegistry.getSpec('claude-opus-4-5-20251101')!;
    expect(spec).toMatchObject({
      displayName: 'Claude Opus 4.5',
      upstreamModelId: 'claude-opus-4-5-20251101',
      maxOutputTokens: 64_000,
      contextWindow: 200_000,
      pool: 'cli',
    });
    expect(spec.inputPricePer1M).toBeUndefined();
    expect(spec.outputPricePer1M).toBeUndefined();
    expect(claudeCodeModelRegistry.getSpec('claude-opus-5-5')).toMatchObject({ maxOutputTokens: 128_000, contextWindow: 1_000_000 });
  });

  test('nothing before Anthropic has answered: no id is written down', () => {
    expect(claudeCodeModelRegistry.listModelIds()).toEqual([]);
    expect(claudeCodeModelRegistry.getSpec('claude-opus-5-5')).toBeNull();
  });

  test('either spelling of a model is the one entry, and an undated id reaches its newest snapshot', async () => {
    await subscription();
    upstream(FIRST_PAGE, SECOND_PAGE);
    await claudeCodeModelList.refresh();

    expect(claudeCodeModelRegistry.getSpec('claude-opus-5.5')).toEqual(claudeCodeModelRegistry.getSpec('claude-opus-5-5'));
    // Anthropic lists Haiku 4.5 only by its snapshot, and answers the undated id as its alias.
    expect(claudeCodeModelRegistry.listModelIds()).not.toContain('claude-haiku-4-5');
    expect(claudeCodeModelRegistry.getSpec('claude-haiku-4-5')?.upstreamModelId).toBe('claude-haiku-4-5-20251001');
    expect(claudeCodeModelRegistry.getSpec('claude-haiku-4.5')?.upstreamModelId).toBe('claude-haiku-4-5-20251001');
    expect(claudeCodeModelRegistry.getSpec('claude-haiku-9')).toBeNull();
  });

  test('of two snapshots of one model, the undated id reaches the newer', () => {
    claudeCodeModelRegistry.mergeLive(
      claudeLiveSpecs([
        { type: 'model', id: 'claude-test-1-20260101', max_tokens: 1000 },
        { type: 'model', id: 'claude-test-1-20260301', max_tokens: 2000 },
      ]),
    );
    expect(claudeCodeModelRegistry.getSpec('claude-test-1')?.upstreamModelId).toBe('claude-test-1-20260301');
  });

  test('a failed answer, or one with no list in it, keeps the last list', async () => {
    await subscription();
    upstream(
      () => page(LIVE, false),
      () => Response.json({ type: 'error', error: { type: 'authentication_error', message: 'invalid' } }, { status: 401 }),
      () => Response.json({ type: 'error' }),
      FIRST_PAGE,
      () => new Response('overloaded', { status: 529 }),
    );
    for (let call = 0; call < 4; call += 1) await claudeCodeModelList.refresh();

    expect(asked).toHaveLength(5);
    expect(claudeCodeModelRegistry.liveModelIds()).toEqual(ALL);
  });

  test('no account, no question', async () => {
    upstream(() => page(LIVE, false));
    await claudeCodeModelList.refresh();
    expect(asked).toHaveLength(0);
  });
});

describe('claudeLiveSpecs', () => {
  test('an entry that is not a model is left out, and an unstated output limit is the conservative default', () => {
    const specs = claudeLiveSpecs([
      { type: 'model', id: 'claude-new-1', display_name: 'Claude New 1' },
      { type: 'something-else', id: 'claude-other-1' },
      { type: 'model', id: 'claude-new-2-20270101' },
      { type: 'model', id: 'claude-new-2' },
    ]);

    expect(specs.map((spec) => spec.modelId)).toEqual(['claude-new-1', 'claude-new-2']);
    expect(specs[0]).toMatchObject({ maxOutputTokens: 32_000, displayName: 'Claude New 1' });
    expect(specs[0]!.contextWindow).toBeUndefined();
  });
});
