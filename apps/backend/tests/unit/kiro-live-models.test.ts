/**
 * Kiro's live catalogue, on the list every provider now shares (`core/live-models.ts`).
 *
 * Kiro already read `ListAvailableModels` at start and after an account was added; it now does so
 * every six hours too, through the same list as the other providers. What a merge does is Kiro's
 * own and unchanged: static definitions stay, a model only the catalogue has comes with its variants,
 * and a failure keeps the last catalogue.
 *
 * The account is a fake loaded into the pool's memory (loading saves nothing) with a token a day from
 * expiry, so no renewal is due; `fetch` is stubbed and nothing reaches AWS.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { kiroAccounts } from '@/providers/kiro/auth/manager';
import type { KiroAccount } from '@/providers/kiro/auth/types';
import { kiroModelRegistry } from '@/providers/kiro/config/model-specs';
import { getKiroConfig } from '@/providers/kiro/config/provider-config';
import { kiroModelList } from '@/providers/kiro';

const ARN = 'arn:aws:codewhisperer:us-east-1:000000000000:profile/TESTPROFILE';

/** Kiro's catalogue answer, as `ListAvailableModels` shapes it. */
const CATALOGUE = {
  models: [
    { modelId: 'claude-opus-5.5', modelName: 'Claude Opus 5.5', rateMultiplier: 2, rateUnit: 'credit', tokenLimits: { maxInputTokens: 1_000_000 } },
    { modelId: 'test-new-model', modelName: 'Test New Model', rateMultiplier: 1, rateUnit: 'credit', tokenLimits: { maxInputTokens: 300_000 } },
  ],
};

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
  test('is asked of the best account, and a model only it has is offered with its variants', async () => {
    kiroAccounts.load({ accounts: [{ ...account }] });
    upstream(() => Response.json(CATALOGUE));
    await kiroModelList.refresh();

    expect(asked).toHaveLength(1);
    const url = new URL(asked[0]!.url);
    expect(`${url.origin}${url.pathname}`).toBe('https://q.us-east-1.amazonaws.com/ListAvailableModels');
    expect(url.searchParams.get('profileArn')).toBe(ARN);
    expect(asked[0]!.headers.get('authorization')).toBe('Bearer test-kiro-access');

    const ids = kiroModelRegistry.listModelIds();
    for (const id of ['test-new-model', 'test-new-model-thinking', 'test-new-model-agentic', 'test-new-model-thinking-agentic']) {
      expect(ids).toContain(id);
    }
    expect(kiroModelRegistry.getSpec('test-new-model')?.contextWindow).toBe(300_000);
  });

  test('a failure keeps the last catalogue', async () => {
    kiroAccounts.load({ accounts: [{ ...account }] });
    upstream(() => Response.json(CATALOGUE), () => new Response('{"message":"denied"}', { status: 403 }));
    await kiroModelList.refresh();
    await kiroModelList.refresh();

    expect(asked).toHaveLength(2);
    expect(kiroModelRegistry.listModelIds()).toContain('test-new-model');
  });

  test('a model the catalogue spells in other case is the static one: its facts, one entry', async () => {
    // The live catalogue of 2026-11-09 listed the static `MiniMax-M2.5` as `minimax-m2.5`, and both were
    // offered, the live one with thinking and agentic variants the static one does not take.
    kiroAccounts.load({ accounts: [{ ...account }] });
    upstream(() =>
      Response.json({
        models: [
          { modelId: 'minimax-m2.5', modelName: 'MiniMax M2.5', rateMultiplier: 0.3, rateUnit: 'credit', tokenLimits: { maxInputTokens: 196_000 } },
          { modelId: 'test-case-model', modelName: 'Test Case Model', tokenLimits: { maxInputTokens: 100_000 } },
          { modelId: 'Test-Case-Model', modelName: 'Test Case Model again' },
        ],
      }),
    );
    await kiroModelList.refresh();

    const ids = kiroModelRegistry.listModelIds();
    expect(ids.filter((id) => id.toLowerCase().startsWith('minimax-m2.5'))).toEqual(['MiniMax-M2.5']);
    expect(ids.filter((id) => id.toLowerCase().startsWith('test-case-model'))).toEqual([
      'test-case-model',
      'test-case-model-agentic',
      'test-case-model-thinking',
      'test-case-model-thinking-agentic',
    ]);
    // The static facts stay — no variants — and the catalogue's own window is taken, as for any static model.
    expect(kiroModelRegistry.getSpec('MiniMax-M2.5')).toMatchObject({ modelId: 'MiniMax-M2.5', upstreamModelId: 'MiniMax-M2.5', contextWindow: 196_000 });
    expect(kiroModelRegistry.getSpec('MiniMax-M2.5-thinking')).toBeNull();
    expect(kiroModelRegistry.describeModel('MiniMax-M2.5')?.rateMultiplier).toBeUndefined();
    // Picked under the catalogue's spelling, while it was listed, it is still that model.
    expect(kiroModelRegistry.getSpec('minimax-m2.5')?.modelId).toBe('MiniMax-M2.5');
    // And the request mapper, which reads the window under the spelling the client sent, finds it.
    expect(kiroModelRegistry.describeModel('minimax-m2.5')?.contextLength).toBe(196_000);
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
