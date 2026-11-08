/**
 * An Antigravity account is offered only the models its own list from Google has.
 *
 * Google moves accounts to a new model generation one by one, and an account asked for a model it
 * does not list answers "no longer available" as a 200 reply: one not yet on Claude 5.5 answers 5.5
 * so, one already moved answers 4.6 so, and the client takes it as the model's answer. The list is
 * what fetchAvailableModels returned for the account. An account with no list yet stays eligible,
 * and a model no account lists fails with an error that names it.
 *
 * The accounts are fakes held in the manager's memory, with tokens that need no refresh, and `fetch`
 * is stubbed: nothing reaches Google and nothing is written.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AntigravityAccount } from '@/providers/antigravity/auth/types';

// Nothing here saves accounts. Should a regression make selection save, the file lands in a scratch
// directory rather than in data/, as long as this test file is the first to load the storage module:
// test files share their modules.
const tempDir = mkdtempSync(join(tmpdir(), 'nougate-model-list-'));
const previousAccountsFile = process.env.ACCOUNTS_FILE;
process.env.ACCOUNTS_FILE = join(tempDir, 'accounts.json');

const { loadProxyConfig } = await import('@/config/manager');
const manager = await import('@/providers/antigravity/auth/manager');
const { fetchQuota, parseAvailableModelIds, parseQuotaResponse } = await import('@/providers/antigravity/api/quota');
const { antigravityModelRegistry } = await import('@/providers/antigravity/config/model-specs');
const { AntigravityExecutor, summarizeExhaustion } = await import('@/providers/antigravity/upstream/executor');
const { generateFingerprint } = await import('@/providers/antigravity/upstream/headers');

const HOUR = 60 * 60 * 1000;
const realFetch = globalThis.fetch;
let accountsBefore: AntigravityAccount[] = [];

/** The ids a real account not yet moved to Claude 5.5 listed on 2026-11-07. */
const NOT_MOVED = [
  'claude-opus-4-6-thinking',
  'claude-sonnet-4-6',
  'gemini-2.5-pro',
  'gemini-3-flash',
  'gemini-3.1-flash-image',
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash-lite',
  'gpt-oss-120b-medium',
];

/** An account moved to 5.5: the registry's 5.5 ids where the 4.6 ones were. */
const MOVED = [
  'claude-opus-5-5-high',
  'claude-opus-5-5-low',
  'claude-opus-5-5-medium',
  'claude-sonnet-5-5-high',
  'claude-sonnet-5-5-low',
  'claude-sonnet-5-5-medium',
  'gemini-2.5-pro',
  'gemini-3-flash',
];

/**
 * An account as selection sees it: a token that needs no refresh, a fingerprint already made (so
 * none is generated and saved), and the list Google gave it, if any.
 */
function account(email: string, availableModels?: string[]): AntigravityAccount {
  return {
    email,
    refreshToken: 'fake-refresh-token',
    accessToken: 'fake-access-token',
    expiresAt: Date.now() + HOUR,
    projectId: 'fake-project',
    fingerprint: generateFingerprint(email),
    healthScore: 100,
    lastUsed: 0,
    tokenUsage: 0,
    availableModels,
  };
}

/** Put these accounts, and only these, in the manager's memory. Nothing is written. */
function hold(...accounts: AntigravityAccount[]): void {
  const held = manager.getAccounts();
  held.splice(0, held.length, ...accounts);
}

/**
 * Every account selection offers for `model`, walked the way the executor walks it: each pick is
 * excluded from the next, until none is left. Who is in it is the point, not the order.
 */
async function offeredFor(model: string): Promise<string[]> {
  const offered: string[] = [];
  for (let step = 0; step <= manager.getAccounts().length; step += 1) {
    const picked = await manager.getBestAccount('sandbox', model, undefined, offered);
    if (!picked) {
      break;
    }
    offered.push(picked.email);
  }
  return offered.sort();
}

beforeAll(async () => {
  accountsBefore = [...manager.getAccounts()];
  // The executor's retry budget reads it.
  await loadProxyConfig();
});

afterEach(() => {
  hold();
  globalThis.fetch = realFetch;
});

afterAll(() => {
  hold(...accountsBefore);
  if (previousAccountsFile === undefined) {
    delete process.env.ACCOUNTS_FILE;
  } else {
    process.env.ACCOUNTS_FILE = previousAccountsFile;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

describe('selection offers an account only the models its list has', () => {
  test('an account without the model is skipped, and one with it is picked', async () => {
    hold(account('not-moved@test.invalid', NOT_MOVED), account('moved@test.invalid', MOVED));

    expect(await offeredFor('claude-sonnet-5-5-high')).toEqual(['moved@test.invalid']);
    expect(await offeredFor('claude-sonnet-4-6')).toEqual(['not-moved@test.invalid']);
    // A model both list is offered on both, as before.
    expect(await offeredFor('gemini-3-flash')).toEqual(['moved@test.invalid', 'not-moved@test.invalid']);
  });

  test('an account whose list is not known yet stays eligible', async () => {
    // Never fetched, or no fetch succeeded: no list on file. An empty list, which no reply gives,
    // is no list either.
    hold(
      account('never-fetched@test.invalid'),
      account('empty-list@test.invalid', []),
      account('not-moved@test.invalid', NOT_MOVED),
    );

    expect(await offeredFor('claude-sonnet-5-5-high')).toEqual([
      'empty-list@test.invalid',
      'never-fetched@test.invalid',
    ]);
  });

  test('a model the registry maps to another id is matched on the id Google lists', async () => {
    const listedAs = antigravityModelRegistry.getSpec('gemini-3.8-flash')?.upstreamModelId;
    expect(listedAs).toBeDefined();
    expect(listedAs).not.toBe('gemini-3.8-flash');

    hold(
      account('lists-it@test.invalid', [listedAs!]),
      account('lists-another@test.invalid', ['gemini-3.8-flash-low']),
    );

    expect(await offeredFor('gemini-3.8-flash')).toEqual(['lists-it@test.invalid']);
  });
});

describe('a model no account lists', () => {
  test('fails with an error that names it, and no account is asked', async () => {
    hold(account('not-moved-a@test.invalid', NOT_MOVED), account('not-moved-b@test.invalid', NOT_MOVED));
    globalThis.fetch = (async () => {
      throw new Error('no request may reach the upstream');
    }) as unknown as typeof fetch;

    const result = await new AntigravityExecutor().execute({
      model: 'antigravity:claude-sonnet-5-5-high',
      modelSpec: antigravityModelRegistry.getSpec('claude-sonnet-5-5-high')!,
      sessionId: 'model-list-session',
      clientId: 'model-list-client',
      // Built only once an account has been picked. Throwing stops that attempt before any request
      // or save, so a regression fails this test rather than reaching Google or the accounts file.
      buildGoogleBody: () => {
        throw new Error('an account was picked for a model no account lists');
      },
      handleSuccess: async () => {
        throw new Error('no answer may come back');
      },
    });

    expect(result.response.status).toBe(404);
    expect(result.accountId).toBe('');
    const body = (await result.response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('model_not_found');
    expect(body.error.message).toContain('antigravity:claude-sonnet-5-5-high');
  });

  test('the answer is the 404 that names the model, where an empty pool otherwise gets the quota one', () => {
    const input = {
      model: 'antigravity:claude-sonnet-4-6',
      attemptCount: 0,
      attemptLogs: [],
      unsupportedCount: 0,
      systemicErrorCount: 0,
      lastStatus: 0,
      resetTime: '3h 10m',
    };

    const listedNowhere = summarizeExhaustion({ ...input, listedNowhere: true });
    expect(listedNowhere.status).toBe(404);
    expect(JSON.stringify(listedNowhere.body)).toContain('model_not_found');
    expect(JSON.stringify(listedNowhere.body)).toContain('antigravity:claude-sonnet-4-6');

    expect(summarizeExhaustion({ ...input, listedNowhere: false }).status).toBe(429);
  });

  test('is one every account has a list for, and none of the lists has', () => {
    hold(account('not-moved-a@test.invalid', NOT_MOVED), account('not-moved-b@test.invalid', NOT_MOVED));
    expect(manager.isModelListedNowhere('claude-sonnet-5-5-high')).toBe(true);

    hold(account('not-moved@test.invalid', NOT_MOVED), account('moved@test.invalid', MOVED));
    expect(manager.isModelListedNowhere('claude-sonnet-5-5-high')).toBe(false);

    // An account whose list is not known yet may have it.
    hold(account('not-moved@test.invalid', NOT_MOVED), account('never-fetched@test.invalid'));
    expect(manager.isModelListedNowhere('claude-sonnet-5-5-high')).toBe(false);

    // With no accounts there is nothing to say about the model.
    hold();
    expect(manager.isModelListedNowhere('claude-sonnet-5-5-high')).toBe(false);
  });
});

describe('the list kept for each account', () => {
  // In the shape parseQuotaResponse reads, with ids a real account listed.
  const reply = {
    availableModels: {
      'models/claude-sonnet-4-6': {
        displayMetadata: { label: 'Claude Sonnet 4.6 (Thinking)' },
        quotaInfo: { remainingFraction: 1 },
      },
      'models/gemini-3-flash': {
        displayMetadata: { label: 'Gemini 3 Flash' },
        quotaInfo: { remainingFraction: 1 },
      },
      // Listed without quota figures: the quota groups leave it out, the model list may not.
      'models/gemini-3.1-flash-lite': {
        displayMetadata: { label: 'Gemini 3.1 Flash Lite' },
      },
    },
  };
  const listed = ['claude-sonnet-4-6', 'gemini-3-flash', 'gemini-3.1-flash-lite'];

  test('is every model the reply lists, with quota figures or without', () => {
    expect(parseAvailableModelIds(reply)).toEqual(listed);

    // Read from the quota groups, the account would lack a model Google lists for it.
    const grouped = (parseQuotaResponse(reply) ?? []).flatMap((group) => group.modelIds ?? []);
    expect(grouped).not.toContain('gemini-3.1-flash-lite');
  });

  test('a reply with no model map gives no list, never an empty one', () => {
    expect(parseAvailableModelIds({})).toBeNull();
    expect(parseAvailableModelIds({ availableModels: {} })).toBeNull();
    // An array names its models by label as often as by id, so it is not read as a list.
    expect(parseAvailableModelIds({ models: [{ displayName: 'Gemini 3 Flash' }] })).toBeNull();
  });

  test('a fetch records it on the account', async () => {
    const fetched = account('fetched@test.invalid');
    globalThis.fetch = (async () => Response.json(reply)) as unknown as typeof fetch;

    await fetchQuota(fetched);

    expect(fetched.availableModels).toEqual(listed);
  });

  test('a fetch that fails, or a reply that cannot be read, changes no list', async () => {
    const neverFetched = account('never-fetched@test.invalid');
    const known = account('known@test.invalid', NOT_MOVED);

    globalThis.fetch = (async () => new Response('unavailable', { status: 503 })) as unknown as typeof fetch;
    expect(await fetchQuota(neverFetched)).toBeNull();
    expect(neverFetched.availableModels).toBeUndefined();
    expect(manager.isModelUnlistedFor(neverFetched, 'claude-sonnet-5-5-high')).toBe(false);

    globalThis.fetch = (async () => Response.json({})) as unknown as typeof fetch;
    await fetchQuota(known);
    expect(known.availableModels).toEqual(NOT_MOVED);
  });
});
