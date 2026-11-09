/**
 * Codex lists the models ChatGPT offers its account, and only those.
 *
 * ChatGPT offered `gpt-6-luna` through Codex while a hand-written list did not have it, so no client
 * could pick it. The provider now reads `GET /backend-api/codex/models` — at start, after an account
 * is added, every six hours — and lists what the Codex CLI's picker shows (`visibility: "list"`). No
 * id is written down.
 *
 * The fixture is the answer a live Plus account gave on 2026-11-09 with `client_version=0.190.0`,
 * trimmed to the fields read and a few beside them. The account is a fake held in a scratch
 * directory, and `fetch` is stubbed: nothing reaches ChatGPT.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addOAuthAccount, getAccounts, initManager } from '@/providers/codex/auth/manager';
import { ProviderResponseError } from '@/core/upstream-errors';
import { CodexExecutor } from '@/providers/codex/upstream/executor';
import { codexModelList } from '@/providers/codex/api/models';
import { codexModelRegistry, getModelSpec } from '@/providers/codex/config/model-specs';
import { getCodexConfig } from '@/providers/codex/config/provider-config';
import { CodexProvider } from '@/providers/codex';
import { CODEX_ANSWER } from './fixtures/upstream-models';

const LIVE = CODEX_ANSWER;
const OFFERED = ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-6-luna'];

/** An id_token carrying the workspace claim, so the account-binding header is sent. */
const ID_TOKEN = ['e30', Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-test' } })).toString('base64url'), 'sig'].join('.');

const home = mkdtempSync(join(tmpdir(), 'nougate-codex-models-'));
const previousHome = process.env.NOUGATE_HOME;
const realFetch = globalThis.fetch;
const realLog = console.log;
const realWarn = console.warn;
let asked: Array<{ url: string; method?: string; headers: Headers }> = [];

/** The upstream answers each call with the next of `answers`. */
function upstream(...answers: Array<() => Response>) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    asked.push({ url: String(input), method: init?.method, headers: new Headers(init?.headers) });
    return answers[asked.length - 1]!();
  }) as typeof fetch;
}

beforeAll(async () => {
  process.env.NOUGATE_HOME = home;
  await initManager();
  // Ten days from expiry: no renewal is due, so the list is the only call made.
  await addOAuthAccount({ accessToken: 'test-access-codex', refreshToken: 'test-refresh-codex', idToken: ID_TOKEN, expiresInSeconds: 10 * 24 * 3600, label: 'codex-test' });
  console.log = () => {};
  console.warn = () => {};
});

afterEach(() => {
  globalThis.fetch = realFetch;
  asked = [];
  codexModelRegistry.mergeLive([]);
});

afterAll(() => {
  console.log = realLog;
  console.warn = realWarn;
  if (previousHome === undefined) delete process.env.NOUGATE_HOME;
  else process.env.NOUGATE_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

describe('the model list Codex is asked for', () => {
  test("is the one beside /responses, for the version requests claim, with the account's credential", async () => {
    upstream(() => Response.json(LIVE));
    await codexModelList.refresh();

    expect(asked).toHaveLength(1);
    expect(asked[0]!.url).toBe('https://chatgpt.com/backend-api/codex/models?client_version=0.190.0');
    expect(asked[0]!.method).toBe('GET');
    expect(asked[0]!.headers.get('authorization')).toBe('Bearer test-access-codex');
    expect(asked[0]!.headers.get('chatgpt-account-id')).toBe('acct-test');
    expect(asked[0]!.headers.get('version')).toBe('0.190.0');
    expect(asked[0]!.headers.get('user-agent')).toBe('codex_cli_rs/0.190.0');
    expect(asked[0]!.headers.get('content-type')).toBeNull();
  });

  test('follows the configured version, which gates the list', async () => {
    const config = getCodexConfig();
    const before = config.cliVersion;
    config.cliVersion = '0.300.0';
    try {
      upstream(() => Response.json(LIVE));
      await codexModelList.refresh();
      expect(new URL(asked[0]!.url).searchParams.get('client_version')).toBe('0.300.0');
      expect(asked[0]!.headers.get('version')).toBe('0.300.0');
    } finally {
      config.cliVersion = before;
    }
  });
});

describe('when the list is asked for', () => {
  /** Wait for `done`, which a background refresh makes true, for up to a second. */
  async function until(done: () => boolean): Promise<void> {
    for (let waited = 0; waited < 1_000 && !done(); waited += 5) await Bun.sleep(5);
  }

  test('once an account is added, without waiting for the timer', async () => {
    // A home of its own, so the account added here is the only one and leaves no second behind.
    const otherHome = mkdtempSync(join(tmpdir(), 'nougate-codex-models-added-'));
    process.env.NOUGATE_HOME = otherHome;
    try {
      await initManager();
      const provider = new CodexProvider();
      await provider.addAccount({});
      upstream(
        () => Response.json({ access_token: 'test-access-added', refresh_token: 'test-refresh-added', id_token: ID_TOKEN, expires_in: 10 * 24 * 3600 }),
        () => Response.json(LIVE),
      );
      await provider.addAccount({ code: 'test-code', label: 'added' });
      await until(() => codexModelRegistry.liveModelIds().length > 0);

      expect(asked.map((call) => `${call.method} ${call.url}`)).toEqual([
        'POST https://auth.openai.com/oauth/token',
        'GET https://chatgpt.com/backend-api/codex/models?client_version=0.190.0',
      ]);
      expect(codexModelRegistry.liveModelIds()).toEqual(OFFERED);
    } finally {
      process.env.NOUGATE_HOME = home;
      await initManager();
      rmSync(otherHome, { recursive: true, force: true });
    }
  });

  test('with a token near its end renewed first, as a request would renew it', async () => {
    const otherHome = mkdtempSync(join(tmpdir(), 'nougate-codex-models-near-'));
    process.env.NOUGATE_HOME = otherHome;
    try {
      await initManager();
      // A day left of a token renewed five days ahead: what the six-hour timer finds on an idle gateway.
      await addOAuthAccount({ accessToken: 'test-access-old', refreshToken: 'test-refresh-near', idToken: ID_TOKEN, expiresInSeconds: 24 * 3600, label: 'near' });
      upstream(
        () => Response.json({ access_token: 'test-access-renewed', refresh_token: 'test-refresh-next', expires_in: 10 * 24 * 3600 }),
        () => Response.json(LIVE),
      );
      await codexModelList.refresh();

      expect(asked.map((call) => `${call.method} ${call.url}`)).toEqual([
        'POST https://auth.openai.com/oauth/token',
        'GET https://chatgpt.com/backend-api/codex/models?client_version=0.190.0',
      ]);
      expect(asked[1]!.headers.get('authorization')).toBe('Bearer test-access-renewed');
    } finally {
      process.env.NOUGATE_HOME = home;
      await initManager();
      rmSync(otherHome, { recursive: true, force: true });
    }
  });
});

describe('what Codex then lists', () => {
  test('exactly what the picker shows, gpt-6-luna among them, with the window the list states and no price', async () => {
    upstream(() => Response.json(LIVE));
    await codexModelList.refresh();

    expect(new CodexProvider().getSupportedModels()).toEqual(OFFERED);
    const spec = codexModelRegistry.getSpec('gpt-6-luna')!;
    expect(spec).toMatchObject({
      modelId: 'gpt-6-luna',
      displayName: 'GPT-6-Luna',
      upstreamModelId: 'gpt-6-luna',
      contextWindow: 272000,
      maxOutputTokens: 128000,
      pool: 'cli',
    });
    expect(spec.inputPricePer1M).toBeUndefined();
    expect(spec.outputPricePer1M).toBeUndefined();
    // No `-review` twin: it would send the same request under a second name.
    expect(codexModelRegistry.listModelIds()).not.toContain('gpt-6-luna-review');
  });

  test('none the picker hides: the review model, experiments, one the API does not take', async () => {
    upstream(() => Response.json(LIVE));
    await codexModelList.refresh();

    for (const hidden of ['gpt-6-chat-thinking', 'gpt-reserve', 'codex-auto-review']) {
      expect(codexModelRegistry.listModelIds()).not.toContain(hidden);
      expect(codexModelRegistry.liveModelIds()).not.toContain(hidden);
    }
  });

  test('nothing before ChatGPT has answered: no id is written down', () => {
    expect(new CodexProvider().getSupportedModels()).toEqual([]);
    expect(codexModelRegistry.liveModelIds()).toEqual([]);
  });

  test('a failed answer, or one with no list in it, keeps the last list', async () => {
    upstream(
      () => Response.json(LIVE),
      () => new Response('{"detail":"Unauthorized"}', { status: 401 }),
      () => Response.json({ detail: 'something else' }),
      () => new Response('<html>bad gateway</html>', { status: 502 }),
    );
    await codexModelList.refresh();
    await codexModelList.refresh();
    await codexModelList.refresh();
    await codexModelList.refresh();

    expect(asked).toHaveLength(4);
    expect(codexModelRegistry.liveModelIds()).toEqual(OFFERED);
  });

  test('a later answer replaces the upstream set: a model it stops listing stops being offered', async () => {
    upstream(
      () => Response.json(LIVE),
      () => Response.json({ models: LIVE.models.filter((model) => model.slug !== 'gpt-6-luna') }),
    );
    await codexModelList.refresh();
    await codexModelList.refresh();

    expect(codexModelRegistry.listModelIds()).toEqual(['gpt-5.6-luna', 'gpt-5.6-terra']);
  });
});

describe('an id the list does not show, asked for by name', () => {
  test("is sent to ChatGPT as written, and its refusal comes back as the error it is, costing no account", async () => {
    const spec = getModelSpec('gpt-6-astra')!;
    expect(spec).toMatchObject({ modelId: 'gpt-6-astra', upstreamModelId: 'gpt-6-astra' });
    const health = getAccounts().map((account) => account.healthScore);
    const sent: string[] = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)).model);
      return Response.json({ detail: "The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account." }, { status: 400 });
    }) as typeof fetch;

    const thrown = await new CodexExecutor().execute({ body: { input: [] }, modelSpec: spec }).catch((error: unknown) => error);

    expect(sent).toEqual(['gpt-6-astra']);
    expect(thrown).toBeInstanceOf(ProviderResponseError);
    expect(thrown).toMatchObject({ status: 400 });
    expect((thrown as Error).message).toContain('not supported');
    expect(getAccounts().map((account) => account.healthScore)).toEqual(health);
  });
});

describe('with more than one account', () => {
  test("every account is asked, the lists united, and one that fails keeps what it listed", async () => {
    const otherHome = mkdtempSync(join(tmpdir(), 'nougate-codex-models-two-'));
    process.env.NOUGATE_HOME = otherHome;
    try {
      await initManager();
      await addOAuthAccount({ accessToken: 'test-access-plus', refreshToken: 'test-refresh-plus', expiresInSeconds: 10 * 24 * 3600, label: 'plus' });
      await addOAuthAccount({ accessToken: 'test-access-pro', refreshToken: 'test-refresh-pro', expiresInSeconds: 10 * 24 * 3600, label: 'pro' });
      // Another plan's list: the model this account's list lacks.
      const PRO = { models: [{ slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', visibility: 'list', context_window: 272000 }] };
      let proAnswer = () => Response.json(PRO);
      const byToken: string[] = [];
      globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
        const token = new Headers(init?.headers).get('authorization');
        byToken.push(String(token));
        return token === 'Bearer test-access-plus' ? Response.json(LIVE) : proAnswer();
      }) as typeof fetch;

      await codexModelList.refresh();
      expect(byToken).toEqual(['Bearer test-access-plus', 'Bearer test-access-pro']);
      expect(codexModelRegistry.listModelIds()).toEqual([...OFFERED, 'gpt-6-astra'].sort());

      proAnswer = () => new Response('{"detail":"Unauthorized"}', { status: 401 });
      await codexModelList.refresh();
      expect(codexModelRegistry.listModelIds()).toContain('gpt-6-astra');
    } finally {
      process.env.NOUGATE_HOME = home;
      await initManager();
      rmSync(otherHome, { recursive: true, force: true });
    }
  });
});
