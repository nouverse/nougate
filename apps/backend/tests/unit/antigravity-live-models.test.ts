/**
 * Antigravity asks every account's `fetchAvailableModels` and offers the union.
 *
 * Google moves accounts to a new model generation one by one: on 2026-11-09 one live account had
 * Claude 5.5 and the other Claude 4.6. Every account is asked; a model any of them lists is offered,
 * and selection keeps each request to the accounts that list it. An account that cannot answer keeps
 * the models its last answer had; when none answers, the last list stays.
 *
 * The accounts are fakes held in the manager's memory with tokens that need no renewal, so nothing is
 * saved; `fetch` is stubbed and answers each account by its token. The kept list goes to a scratch data
 * directory.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AntigravityAccount } from '@/providers/antigravity/auth/types';

const home = mkdtempSync(join(tmpdir(), 'nougate-antigravity-models-'));
const previousHome = process.env.NOUGATE_HOME;
process.env.NOUGATE_HOME = home;

const manager = await import('@/providers/antigravity/auth/manager');
const { antigravityModelList } = await import('@/providers/antigravity/api/models');
const { antigravityModelRegistry } = await import('@/providers/antigravity/config/model-specs');
const { generateFingerprint } = await import('@/providers/antigravity/upstream/headers');
const { ANTIGRAVITY_MOVED_REPLY, ANTIGRAVITY_NOT_MOVED_REPLY } = await import('./fixtures/upstream-models');

const HOUR = 3_600_000;
const realFetch = globalThis.fetch;
const realLog = console.log;
const realWarn = console.warn;
let accountsBefore: AntigravityAccount[] = [];
let asked: Array<{ url: string; token: string | null; body: string }> = [];

function account(email: string, token: string, availableModels?: string[]): AntigravityAccount {
  return {
    email,
    refreshToken: `refresh-${token}`,
    accessToken: token,
    expiresAt: Date.now() + HOUR,
    projectId: `project-${token}`,
    fingerprint: generateFingerprint(email),
    healthScore: 100,
    lastUsed: 0,
    tokenUsage: 0,
    ...(availableModels ? { availableModels } : {}),
  };
}

function hold(...accounts: AntigravityAccount[]): void {
  const held = manager.getAccounts();
  held.splice(0, held.length, ...accounts);
}

/** Google answers each account by its token: a reply, or a status. */
function google(answers: Record<string, () => Response>) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const token = new Headers(init?.headers).get('authorization')?.replace('Bearer ', '') ?? null;
    asked.push({ url: String(input), token, body: String(init?.body) });
    return answers[token ?? '']!();
  }) as typeof fetch;
}

const ids = () => antigravityModelRegistry.listModelIds();

beforeAll(() => {
  accountsBefore = [...manager.getAccounts()];
  console.log = () => {};
  console.warn = () => {};
});

afterEach(() => {
  globalThis.fetch = realFetch;
  asked = [];
  hold();
  antigravityModelRegistry.mergeLive([]);
});

afterAll(() => {
  hold(...accountsBefore);
  console.log = realLog;
  console.warn = realWarn;
  if (previousHome === undefined) delete process.env.NOUGATE_HOME;
  else process.env.NOUGATE_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

describe("Antigravity's list", () => {
  test("is every account's fetchAvailableModels, united", async () => {
    hold(account('moved@test.invalid', 'token-moved'), account('not-moved@test.invalid', 'token-not-moved'));
    google({ 'token-moved': () => Response.json(ANTIGRAVITY_MOVED_REPLY), 'token-not-moved': () => Response.json(ANTIGRAVITY_NOT_MOVED_REPLY) });
    await antigravityModelList.refresh();

    expect(asked.map((call) => call.url)).toEqual([
      'https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
      'https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
    ]);
    expect(asked.map((call) => JSON.parse(call.body).project).sort()).toEqual(['project-token-moved', 'project-token-not-moved']);
    expect(ids()).toContain('claude-sonnet-5-5-high');
    expect(ids()).toContain('claude-sonnet-4-6');
    expect(ids()).toContain('gemini-3.8-flash-medium');
  });

  test('an account that cannot answer keeps the models its last answer had', async () => {
    hold(
      account('moved@test.invalid', 'token-moved', Object.keys(ANTIGRAVITY_MOVED_REPLY.models)),
      account('not-moved@test.invalid', 'token-not-moved', Object.keys(ANTIGRAVITY_NOT_MOVED_REPLY.models)),
    );
    google({ 'token-moved': () => Response.json(ANTIGRAVITY_MOVED_REPLY), 'token-not-moved': () => Response.json(ANTIGRAVITY_NOT_MOVED_REPLY) });
    await antigravityModelList.refresh();

    google({ 'token-moved': () => Response.json(ANTIGRAVITY_MOVED_REPLY), 'token-not-moved': () => new Response('{"error":"unavailable"}', { status: 503 }) });
    await antigravityModelList.refresh();

    // Claude 4.6 only the silent account lists: it stays.
    expect(ids()).toContain('claude-sonnet-4-6');
    expect(ids()).toContain('claude-opus-4-6-thinking');
  });

  test('when no account answers, the last list stays', async () => {
    hold(account('moved@test.invalid', 'token-moved'));
    google({ 'token-moved': () => Response.json(ANTIGRAVITY_MOVED_REPLY) });
    await antigravityModelList.refresh();
    const before = ids();

    google({ 'token-moved': () => new Response('{"error":"unavailable"}', { status: 503 }) });
    await antigravityModelList.refresh();

    expect(before.length).toBeGreaterThan(0);
    expect(ids()).toEqual(before);
  });

  test('a model an account stops listing, with every account answering, stops being offered', async () => {
    hold(account('moved@test.invalid', 'token-moved'));
    google({ 'token-moved': () => Response.json(ANTIGRAVITY_NOT_MOVED_REPLY) });
    await antigravityModelList.refresh();
    google({ 'token-moved': () => Response.json(ANTIGRAVITY_MOVED_REPLY) });
    await antigravityModelList.refresh();

    expect(ids()).not.toContain('claude-sonnet-4-6');
    expect(ids()).toContain('claude-opus-5-5-high');
  });

  test('nothing before Google has answered, and no account, no question', async () => {
    google({});
    await antigravityModelList.refresh();
    expect(asked).toHaveLength(0);
    expect(ids()).toEqual([]);
  });
});

describe('an account added', () => {
  // Adding one exchanges a code with Google and saves the pool, which a test must not do, so the two
  // paths — the provider's and the dashboard's OAuth callback — are read rather than run.
  test.each([
    ['src/providers/antigravity/index.ts'],
    ['src/router/admin.ts'],
  ])('through %s, has the list asked for once it is stored', (file) => {
    const source = readFileSync(join(import.meta.dir, '..', '..', file), 'utf8');
    const stored = source.split('await addAccount(newAccount);').slice(1);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.trimStart()).toStartWith('void antigravityModelList.refresh();');
  });
});
