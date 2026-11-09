/**
 * Kiro's models are the ones its catalogue lists (`core/live-models.ts`).
 *
 * Kiro reads `ListAvailableModels` at start, after an account is added and every six hours, and that
 * is its list: no id is written down. What a model takes comes from its own entry where the
 * catalogue says (input types, window, output limit, credit rate); which models take the `-thinking`
 * and `-agentic` variants is a rule by family, as the catalogue does not say. A failure keeps the last
 * catalogue.
 *
 * The fixture is the catalogue an AWS Builder ID account was given on 2026-11-09. The account is a
 * fake loaded into the pool's memory (loading saves nothing) with a token a day from expiry, so no
 * renewal is due; `fetch` is stubbed and nothing reaches AWS.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { kiroAccounts } from '@/providers/kiro/auth/manager';
import type { KiroAccount } from '@/providers/kiro/auth/types';
import { kiroModelRegistry } from '@/providers/kiro/config/model-specs';
import { getKiroConfig } from '@/providers/kiro/config/provider-config';
import { kiroModelList } from '@/providers/kiro';
import { convertOpenAIMessages } from '@/providers/kiro/mappers/openai';
import { prepareKiroRequest } from '@/providers/kiro/mappers/payload';
import { KIRO_ANSWER } from './fixtures/upstream-models';

// The list keeps its answer on disk: in a scratch data directory, never the real one.
const modelsHome = mkdtempSync(join(tmpdir(), 'nougate-models-home-'));
const previousModelsHome = process.env.NOUGATE_HOME;
process.env.NOUGATE_HOME = modelsHome;
afterAll(() => {
  if (previousModelsHome === undefined) delete process.env.NOUGATE_HOME;
  else process.env.NOUGATE_HOME = previousModelsHome;
  rmSync(modelsHome, { recursive: true, force: true });
});

const ARN = 'arn:aws:codewhisperer:us-east-1:000000000000:profile/TESTPROFILE';

/** Kiro's catalogue answer, as `ListAvailableModels` shapes it. */
const CATALOGUE = KIRO_ANSWER;

const account: KiroAccount = {
  id: 'kiro-test',
  label: 'kiro-test',
  authMethod: 'social',
  accessToken: 'test-kiro-access',
  refreshToken: 'test-kiro-refresh',
  expiresAt: Date.now() + 24 * 3_600_000,
  region: 'us-east-1',
  profileArn: ARN,
  healthScore: 100,
  lastUsed: 0,
  consecutiveFailures: 0,
};

const realFetch = globalThis.fetch;
const realLog = console.log;
const realWarn = console.warn;
let accountsBefore: KiroAccount[] = [];
let asked: Array<{ url: string; headers: Headers }> = [];

function upstream(...answers: Array<() => Response>) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    asked.push({ url: String(input), headers: new Headers(init?.headers) });
    return answers[asked.length - 1]!();
  }) as typeof fetch;
}

beforeAll(() => {
  accountsBefore = [...kiroAccounts.list()];
  console.log = () => {};
  console.warn = () => {};
});

afterEach(() => {
  globalThis.fetch = realFetch;
  asked = [];
  kiroModelRegistry.mergeLive([]);
  kiroAccounts.load({ accounts: [] });
});

afterAll(() => {
  kiroAccounts.load({ accounts: accountsBefore });
  console.log = realLog;
  console.warn = realWarn;
});

describe("Kiro's live catalogue", () => {
  test('is asked of the account, and what it lists is the list', async () => {
    kiroAccounts.load({ accounts: [{ ...account }] });
    upstream(() => Response.json(CATALOGUE));
    await kiroModelList.refresh();

    expect(asked).toHaveLength(1);
    const url = new URL(asked[0]!.url);
    expect(`${url.origin}${url.pathname}`).toBe('https://q.us-east-1.amazonaws.com/ListAvailableModels');
    expect(url.searchParams.get('profileArn')).toBe(ARN);
    expect(asked[0]!.headers.get('authorization')).toBe('Bearer test-kiro-access');

    const bases = kiroModelRegistry.listModelIds().filter((id) => !/-(thinking|agentic)$/.test(id));
    expect(bases).toEqual(['auto', 'claude-haiku-4.5', 'claude-sonnet-4.5', 'deepseek-3.2', 'glm-5', 'minimax-m2.1', 'minimax-m2.5', 'qwen3-coder-next']);
  });

  test('nothing before Kiro has answered: no id is written down', () => {
    expect(kiroModelRegistry.listModelIds()).toEqual([]);
    // Not offered; asked for by name, it is sent with a default spec and Kiro's answer decides.
    expect(kiroModelRegistry.getSpec('claude-opus-5.5')).toMatchObject({ modelId: 'claude-opus-5.5', upstreamModelId: 'claude-opus-5.5' });
  });

  test("each model takes what its entry says: its window, its output limit, images only where it lists them", async () => {
    kiroAccounts.load({ accounts: [{ ...account }] });
    upstream(() => Response.json(CATALOGUE));
    await kiroModelList.refresh();

    expect(kiroModelRegistry.getSpec('claude-sonnet-4.5')).toMatchObject({ contextWindow: 200_000, maxOutputTokens: 64000, inputModalities: ['text', 'image'] });
    expect(kiroModelRegistry.getSpec('deepseek-3.2')).toMatchObject({ contextWindow: 164_000, inputModalities: ['text'] });
    expect(kiroModelRegistry.describeModel('deepseek-3.2')?.rateMultiplier).toBe(0.25);
  });

  test('variants by family: Claude and GPT take both, auto thinking only, the others none', async () => {
    kiroAccounts.load({ accounts: [{ ...account }] });
    upstream(() =>
      Response.json({
        models: [...CATALOGUE.models, { modelId: 'gpt-7-test', modelName: 'GPT 7 Test', supportedInputTypes: ['TEXT', 'IMAGE'] }],
      }),
    );
    await kiroModelList.refresh();

    const ids = kiroModelRegistry.listModelIds();
    for (const id of ['claude-haiku-4.5-thinking', 'claude-haiku-4.5-agentic', 'claude-haiku-4.5-thinking-agentic', 'gpt-7-test-thinking-agentic', 'auto-thinking']) {
      expect(ids).toContain(id);
    }
    for (const id of ['auto-agentic', 'deepseek-3.2-thinking', 'minimax-m2.5-agentic', 'glm-5-thinking', 'qwen3-coder-next-thinking']) {
      expect(ids).not.toContain(id);
    }
  });

  test('a failure keeps the last catalogue', async () => {
    kiroAccounts.load({ accounts: [{ ...account }] });
    upstream(() => Response.json(CATALOGUE), () => new Response('{"message":"denied"}', { status: 403 }));
    await kiroModelList.refresh();
    await kiroModelList.refresh();

    expect(asked).toHaveLength(2);
    expect(kiroModelRegistry.listModelIds()).toContain('minimax-m2.5');
  });

  test('two entries that differ only in case are one model, and another spelling reaches it', async () => {
    kiroAccounts.load({ accounts: [{ ...account }] });
    upstream(() =>
      Response.json({
        models: [
          { modelId: 'minimax-m2.5', modelName: 'MiniMax M2.5', supportedInputTypes: ['TEXT'], tokenLimits: { maxInputTokens: 196_000 } },
          { modelId: 'MiniMax-M2.5', modelName: 'MiniMax M2.5 again' },
        ],
      }),
    );
    await kiroModelList.refresh();

    expect(kiroModelRegistry.listModelIds()).toEqual(['minimax-m2.5']);
    expect(kiroModelRegistry.getSpec('MiniMax-M2.5')).toMatchObject({ modelId: 'minimax-m2.5', displayName: 'MiniMax M2.5' });
    expect(kiroModelRegistry.describeModel('MiniMax-M2.5')?.contextLength).toBe(196_000);
  });

  test('a request is sent under the spelling the catalogue lists, and as written for a model it does not list', async () => {
    const sentAs = (requestedModel: string): string => {
      const payload: any = prepareKiroRequest({
        requestedModel,
        body: { messages: [{ role: 'user', content: 'hi' }] },
        headers: null,
        tools: [],
        systemText: '',
        convert: (model) => convertOpenAIMessages([{ role: 'user', content: 'hi' }], model, { images: false }),
      }).forAccount({ id: 'kiro-test', authMethod: 'social', profileArn: ARN });
      return payload.conversationState.currentMessage.userInputMessage.modelId;
    };

    kiroAccounts.load({ accounts: [{ ...account }] });
    upstream(() => Response.json(CATALOGUE));
    await kiroModelList.refresh();

    // Kiro refused `MiniMax-M2.5` on 2026-11-09 and answered `minimax-m2.5`.
    expect(sentAs('MiniMax-M2.5')).toBe('minimax-m2.5');
    expect(sentAs('CLAUDE-SONNET-4.5-thinking')).toBe('claude-sonnet-4.5');
    expect(sentAs('not-listed-model')).toBe('not-listed-model');
  });

  test('switched off, or with no account, nothing is asked', async () => {
    upstream(() => Response.json(CATALOGUE));
    await kiroModelList.refresh();

    kiroAccounts.load({ accounts: [{ ...account }] });
    const features = getKiroConfig().features;
    features.liveModelCatalog = false;
    try {
      await kiroModelList.refresh();
    } finally {
      features.liveModelCatalog = true;
    }

    expect(asked).toHaveLength(0);
  });
});

describe('with more than one account', () => {
  test('every account is asked, the catalogues united, and one that fails keeps what it listed', async () => {
    kiroAccounts.load({ accounts: [{ ...account }, { ...account, id: 'kiro-second', label: 'kiro-second', accessToken: 'test-kiro-second' }] });
    const SECOND = { models: [{ modelId: 'claude-opus-4.5', modelName: 'Claude Opus 4.5', supportedInputTypes: ['TEXT', 'IMAGE'], tokenLimits: { maxInputTokens: 200_000 } }] };
    let secondAnswer = () => Response.json(SECOND);
    const byToken: string[] = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const token = new Headers(init?.headers).get('authorization');
      byToken.push(String(token));
      return token === 'Bearer test-kiro-access' ? Response.json(CATALOGUE) : secondAnswer();
    }) as typeof fetch;

    await kiroModelList.refresh();
    expect(byToken).toEqual(['Bearer test-kiro-access', 'Bearer test-kiro-second']);
    expect(kiroModelRegistry.listModelIds()).toContain('claude-opus-4.5');
    expect(kiroModelRegistry.listModelIds()).toContain('minimax-m2.5');

    secondAnswer = () => new Response('{"message":"denied"}', { status: 403 });
    await kiroModelList.refresh();
    expect(kiroModelRegistry.listModelIds()).toContain('claude-opus-4.5');
  });
});
