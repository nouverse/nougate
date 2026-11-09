/**
 * Codex lists the models ChatGPT offers its account, not only the ones written down.
 *
 * ChatGPT offered `gpt-6-luna` through Codex while the written list did not have it, so no client
 * could pick it. The provider now reads `GET /backend-api/codex/models` — at start, after an account
 * is added, every six hours — and lists what the Codex CLI's picker shows (`visibility: "list"`).
 *
 * The fixture is the answer a live Plus account gave on 2026-11-09 with `client_version=0.190.0`,
 * trimmed to the fields read and a few beside them. The account is a fake held in a scratch
 * directory, and `fetch` is stubbed: nothing reaches ChatGPT.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addOAuthAccount, initManager } from '@/providers/codex/auth/manager';
import { codexModelList } from '@/providers/codex/api/models';
import { codexModelRegistry } from '@/providers/codex/config/model-specs';
import { getCodexConfig } from '@/providers/codex/config/provider-config';
import { CodexProvider } from '@/providers/codex';

const listed = (slug: string, display_name: string, visibility: 'list' | 'hide', priority: number, supported_in_api = true) => ({
  slug,
  display_name,
  visibility,
  supported_in_api,
  priority,
  upgrade: null,
  context_window: 272000,
  max_context_window: 872000,
  input_modalities: ['text', 'image'],
  default_reasoning_level: 'medium',
});

/** What a live account was offered on 2026-11-09. Three are hidden from the CLI's picker. */
const LIVE = {
  models: [
    listed('gpt-6-chat-thinking', 'GPT-6 Chat Thinking', 'hide', 1, false),
    listed('gpt-reserve', 'GPT-Reserve', 'hide', 2),
    listed('gpt-6-luna', 'GPT-6-Luna', 'list', 3),
    listed('gpt-5.6-terra', 'GPT-5.6-Terra', 'list', 4),
    listed('gpt-5.6-luna', 'GPT-5.6-Luna', 'list', 5),
    listed('codex-auto-review', 'Codex Auto Review', 'hide', 6),
  ],
};

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
    expect(codexModelRegistry.liveModelIds()).toEqual(['gpt-6-luna']);
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
  test('gpt-6-luna, which the picker shows and the written list lacks', async () => {
    upstream(() => Response.json(LIVE));
    await codexModelList.refresh();

    expect(new CodexProvider().getSupportedModels()).toContain('gpt-6-luna');
    expect(codexModelRegistry.liveModelIds()).toEqual(['gpt-6-luna']);
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
    expect(codexModelRegistry.getSpec('gpt-6-luna-review')).toBeNull();
  });

  test('none the picker hides: the review model, experiments, one the API does not take', async () => {
    upstream(() => Response.json(LIVE));
    await codexModelList.refresh();

    for (const hidden of ['gpt-6-chat-thinking', 'gpt-reserve', 'codex-auto-review']) {
      expect(codexModelRegistry.listModelIds()).not.toContain(hidden);
      expect(codexModelRegistry.getSpec(hidden)).toBeNull();
    }
  });

  test('a written model keeps its own spec', async () => {
    const written = codexModelRegistry.getSpec('gpt-5.6-luna');
    upstream(() => Response.json(LIVE));
    await codexModelList.refresh();

    expect(codexModelRegistry.getSpec('gpt-5.6-luna')).toEqual(written);
    expect(codexModelRegistry.getSpec('gpt-5.6-luna')?.displayName).toBe('GPT 5.6 Luna');
    // Written models the upstream does not list for this account stay listed.
    expect(codexModelRegistry.listModelIds()).toContain('gpt-6-astra');
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
    expect(codexModelRegistry.liveModelIds()).toEqual(['gpt-6-luna']);
  });

  test('a later answer replaces the upstream set: a model it stops listing stops being offered', async () => {
    upstream(
      () => Response.json(LIVE),
      () => Response.json({ models: LIVE.models.filter((model) => model.slug !== 'gpt-6-luna') }),
    );
    await codexModelList.refresh();
    await codexModelList.refresh();

    expect(codexModelRegistry.listModelIds()).not.toContain('gpt-6-luna');
    expect(codexModelRegistry.listModelIds()).toContain('gpt-5.6-luna');
  });
});
