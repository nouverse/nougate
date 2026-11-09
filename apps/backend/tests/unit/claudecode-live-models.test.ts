/**
 * Claude Code lists the models Anthropic lists for its credential, not only the ones written down.
 *
 * The provider reads `GET /v1/models` — at start, after an account is added, every six hours — with
 * the credential a request uses: on the subscription login, `Bearer` with the `oauth-2025-04-20` gate.
 * A written model keeps its spec, price included. Anthropic lists older models by a dated snapshot
 * (`claude-haiku-4-5-20251001`) beside the written undated id; that is one model, listed once.
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
import { claudeCodeModelRegistry, claudeLiveSpecs } from '@/providers/claudecode/config/model-specs';
import { ClaudeCodeProvider } from '@/providers/claudecode';

// The list keeps its answer on disk: in a scratch data directory, never the real one.
const modelsHome = mkdtempSync(join(tmpdir(), 'nougate-models-home-'));
const previousModelsHome = process.env.NOUGATE_HOME;
process.env.NOUGATE_HOME = modelsHome;
afterAll(() => {
  if (previousModelsHome === undefined) delete process.env.NOUGATE_HOME;
  else process.env.NOUGATE_HOME = previousModelsHome;
  rmSync(modelsHome, { recursive: true, force: true });
});

const model = (id: string, display_name: string, created_at: string, max_input_tokens: number, max_tokens: number) => ({
  type: 'model',
  id,
  display_name,
  created_at,
  line: id.split('-')[1],
  max_input_tokens,
  max_tokens,
});

/** What a live subscription login was listed on 2026-11-09, newest first, as Anthropic orders it. */
const LIVE = [
  model('claude-haiku-5-5', 'Claude Haiku 5.5', '2026-10-07T18:00:00Z', 1_000_000, 128_000),
  model('claude-sonnet-5-5', 'Claude Sonnet 5.5', '2026-09-28T00:00:00Z', 1_000_000, 128_000),
  model('claude-opus-5-5', 'Claude Opus 5.5', '2026-09-21T16:24:00Z', 1_000_000, 128_000),
  model('claude-fable-5-1', 'Claude Fable 5.1', '2026-08-28T00:00:00Z', 1_000_000, 128_000),
  model('claude-opus-5', 'Claude Opus 5', '2026-07-24T00:00:00Z', 1_000_000, 128_000),
  model('claude-sonnet-5', 'Claude Sonnet 5', '2026-06-29T00:00:00Z', 1_000_000, 128_000),
  model('claude-fable-5', 'Claude Fable 5', '2026-06-07T00:00:00Z', 1_000_000, 128_000),
  model('claude-opus-4-8', 'Claude Opus 4.8', '2026-05-28T00:00:00Z', 1_000_000, 128_000),
  model('claude-opus-4-7', 'Claude Opus 4.7', '2026-04-14T00:00:00Z', 1_000_000, 128_000),
  model('claude-sonnet-4-6', 'Claude Sonnet 4.6', '2026-02-17T00:00:00Z', 1_000_000, 128_000),
  model('claude-opus-4-6', 'Claude Opus 4.6', '2026-02-04T00:00:00Z', 1_000_000, 128_000),
  model('claude-opus-4-5-20251101', 'Claude Opus 4.5', '2025-11-24T00:00:00Z', 200_000, 64_000),
  model('claude-haiku-4-5-20251001', 'Claude Haiku 4.5', '2025-10-15T00:00:00Z', 200_000, 64_000),
];

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
  test('a model only Anthropic lists, with the limits its list states and no price', async () => {
    await subscription();
    upstream(FIRST_PAGE, SECOND_PAGE);
    await claudeCodeModelList.refresh();

    expect(claudeCodeModelRegistry.liveModelIds()).toEqual(['claude-opus-4-5-20251101']);
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
  });

  test('a dated snapshot of a written model is that model, listed once', async () => {
    await subscription();
    upstream(FIRST_PAGE, SECOND_PAGE);
    await claudeCodeModelList.refresh();

    const ids = claudeCodeModelRegistry.listModelIds();
    expect(ids).not.toContain('claude-haiku-4-5-20251001');
    expect(ids).toContain('claude-haiku-4-5');
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('a written model keeps its spec, price included, under either spelling', async () => {
    const written = claudeCodeModelRegistry.getSpec('claude-opus-5-5');
    await subscription();
    upstream(FIRST_PAGE, SECOND_PAGE);
    await claudeCodeModelList.refresh();

    expect(claudeCodeModelRegistry.getSpec('claude-opus-5-5')).toEqual(written);
    expect(claudeCodeModelRegistry.getSpec('claude-opus-5.5')).toEqual(written);
    expect(written).toMatchObject({ inputPricePer1M: 5, outputPricePer1M: 25, maxOutputTokens: 128_000 });
    expect(claudeCodeModelRegistry.getSpec('claude-opus-5-5')?.contextWindow).toBeUndefined();
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
    expect(claudeCodeModelRegistry.liveModelIds()).toEqual(['claude-opus-4-5-20251101']);
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
