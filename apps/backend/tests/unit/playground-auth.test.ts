/**
 * How the dashboard Playground reaches the proxy routes without holding a key.
 *
 * Keys are stored as a hash, so nothing can hand a signed-in operator the secret back. The Playground
 * therefore authorises with its session and names a key only to say who the request is billed to.
 * That trade is only safe if three things hold, and each one is a test below:
 *
 *   - The key id alone authorises nothing. Without a session it is an ordinary unauthenticated
 *     request, and stays a 401.
 *   - A session alone attributes to nothing. It is the header that names the ledger, so a request
 *     without one does not get charged to an arbitrary key.
 *   - A key that is revoked or expired is refused here exactly as `verifyApiKey` refuses it, or
 *     revocation would stop meaning revocation for anyone with a dashboard login.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const STATE_DIR = mkdtempSync(join(tmpdir(), 'nougate-playground-'));

// Both are read when their modules are first imported, so they must be set before those imports.
process.env.NOUGATE_DB_PATH = join(STATE_DIR, 'playground-test.db');
process.env.SESSION_SECRET = 'test-secret-for-playground-auth-cases';

const { loadProxyConfig } = await import('@/config/manager');
const { initDb, closeDb } = await import('@/core/db');
const keys = await import('@/auth/api-keys');
const { createUser } = await import('@/auth/users');
const { createSessionCookie, SESSION_COOKIE } = await import('@/auth/session');
const { registerHandler, registerProvider } = await import('@/core/registry');
const { handleRequest } = await import('@/router');

const PATH = '/openai/v1/chat/completions';

/** Records what the router decided, so a test can read the attribution rather than infer it. */
let lastSeen: { apiKeyId?: string; clientId?: string } | null = null;

let sessionCookie = '';

beforeAll(async () => {
  await loadProxyConfig();
  await initDb();
  await keys.initApiKeys();

  const user = await createUser('playground-tester', 'a-long-enough-password');
  const setCookie = createSessionCookie(user, 'http://localhost:3000');
  sessionCookie = setCookie.split(';')[0]!;
  expect(sessionCookie.startsWith(`${SESSION_COOKIE}=`)).toBe(true);

  // A provider and handler of our own: this exercises the router's auth and attribution, not any
  // real upstream. The handler reports what reached it and nothing else.
  registerProvider({
    id: 'testprov',
    displayName: 'testprov',
    init: async () => {},
    getJitterConfig: () => ({ jitterEnabled: false, jitterMinMs: 0, jitterMaxMs: 0 }),
    getBestAccount: async () => null,
    updateAccountUsage: async () => {},
    getAccounts: () => [],
    getModelRegistry: () => ({ getSpec: () => null, listModelIds: () => [] }),
    getSupportedModels: () => [],
    execute: async () => new Response('unused'),
  });

  registerHandler({
    protocol: 'openai',
    paths: [PATH],
    methods: ['POST'],
    handle: async (ctx: any) => {
      lastSeen = { apiKeyId: ctx.apiKeyId, clientId: ctx.clientId };
      return new Response('reached', { status: 200 });
    },
  } as any);
});

afterAll(async () => {
  await closeDb();
  rmSync(STATE_DIR, { recursive: true, force: true });
});

function post(headers: Record<string, string>): Promise<Response> {
  lastSeen = null;
  return handleRequest(
    new Request(`http://localhost:3000${PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ model: 'testprov:anything' }),
    }),
  );
}

describe('the Playground path', () => {
  test('a key id without a session authorises nothing', async () => {
    const created = await keys.createApiKey({ name: 'playground-key' });
    const response = await post({ 'x-nougate-api-key-id': created.id });

    expect(response.status).toBe(401);
    expect(lastSeen).toBeNull();
  });

  test('a session plus a key id reaches the handler and is billed to that key', async () => {
    const created = await keys.createApiKey({ name: 'billed-to-me' });
    const response = await post({ cookie: sessionCookie, 'x-nougate-api-key-id': created.id });

    expect(response.status).toBe(200);
    expect(lastSeen?.apiKeyId).toBe(created.id);
    // The key's name is what per-client cost attribution groups by.
    expect(lastSeen?.clientId).toBe('billed-to-me');
  });

  test('a session with no key id is still unauthenticated', async () => {
    // The session is not a licence to call the proxy anonymously; something has to be billed.
    const response = await post({ cookie: sessionCookie });

    expect(response.status).toBe(401);
    expect(lastSeen).toBeNull();
  });

  test('a revoked key is refused even with a valid session', async () => {
    const created = await keys.createApiKey({ name: 'about-to-be-revoked' });
    await keys.revokeApiKey(created.id);

    const response = await post({ cookie: sessionCookie, 'x-nougate-api-key-id': created.id });
    expect(response.status).toBe(401);
    expect(lastSeen).toBeNull();
  });

  test('an expired key is refused even with a valid session', async () => {
    const created = await keys.createApiKey({ name: 'expired-key', expiresInDays: 1 });
    await keys.updateApiKeyExpiry(created.id, Date.now() - 1000);

    const response = await post({ cookie: sessionCookie, 'x-nougate-api-key-id': created.id });
    expect(response.status).toBe(401);
    expect(lastSeen).toBeNull();
  });

  test('an id that matches no key is refused', async () => {
    const response = await post({ cookie: sessionCookie, 'x-nougate-api-key-id': 'not-a-real-id' });
    expect(response.status).toBe(401);
    expect(lastSeen).toBeNull();
  });

  test('a real secret still works and still wins over the header', async () => {
    // The header is a fallback for callers that cannot hold a secret, never an override for one.
    const withSecret = await keys.createApiKey({ name: 'holds-the-secret' });
    const other = await keys.createApiKey({ name: 'not-this-one' });

    const response = await post({
      authorization: `Bearer ${withSecret.key}`,
      'x-nougate-api-key-id': other.id,
    });

    expect(response.status).toBe(200);
    expect(lastSeen?.apiKeyId).toBe(withSecret.id);
  });
});
