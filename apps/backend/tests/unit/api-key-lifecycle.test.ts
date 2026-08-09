import { expect, test, describe, beforeAll, afterAll } from 'bun:test';
import { rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const STATE_DIR = mkdtempSync(join(tmpdir(), 'nougate-api-keys-'));

// Read when the db module is first imported, so it must be set before the import.
process.env.NOUGATE_DB_PATH = join(STATE_DIR, 'api-keys-test.db');

const { loadProxyConfig } = await import('@/config/manager');
const { initDb, closeDb } = await import('@/core/db');
const keys = await import('@/auth/api-keys');
const { handleApiKeysRoute } = await import('@/router/api-keys');

function route(path: string, method = 'GET', body?: unknown) {
  return handleApiKeysRoute(
    new Request(`http://localhost:3000${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    new URL(`http://localhost:3000${path}`),
  );
}

beforeAll(async () => {
  await loadProxyConfig();
  await initDb();
  await keys.initApiKeys();
});

afterAll(async () => {
  await closeDb();
  rmSync(STATE_DIR, { recursive: true, force: true });
});

describe('Rotating a key', () => {
  test('issues a new working secret and kills the old one', async () => {
    const created = await keys.createApiKey({ name: 'zed' });
    expect(keys.verifyApiKey(created.key).ok).toBe(true);

    const rotated = await keys.rotateApiKey(created.id);
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) return;

    expect(rotated.key.key).not.toBe(created.key);
    // The cache is what verification reads; a rotation that forgets to refresh it
    // leaves the new secret rejected and the old one still working.
    expect(keys.verifyApiKey(rotated.key.key).ok).toBe(true);
    expect(keys.verifyApiKey(created.key)).toEqual({ ok: false, reason: 'invalid' });
  });

  test('keeps the identity the metrics join on, and the counters', async () => {
    const created = await keys.createApiKey({ name: 'openclaw', expiresInDays: 30 });
    keys.touchApiKey(created.id);
    keys.touchApiKey(created.id);

    const rotated = await keys.rotateApiKey(created.id);
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) return;

    // A new id would split this key's spend into a second bar labelled the same.
    expect(rotated.key.id).toBe(created.id);
    expect(rotated.key.name).toBe('openclaw');
    expect(rotated.key.expiresAt).toBe(created.expiresAt);
    expect(rotated.key.requestCount).toBe(2);
    expect(rotated.key.keyPrefix).toBe(rotated.key.key.slice(0, 13) + '...' + rotated.key.key.slice(-4));
  });

  test('refuses a revoked key rather than handing back a dead secret', async () => {
    const created = await keys.createApiKey({ name: 'retired' });
    await keys.revokeApiKey(created.id);

    expect(await keys.rotateApiKey(created.id)).toEqual({ ok: false, reason: 'revoked' });
    expect(await keys.rotateApiKey('no-such-key')).toEqual({ ok: false, reason: 'not-found' });
  });
});

describe('Changing an expiry', () => {
  test('a new date is enforced on the next verification', async () => {
    const created = await keys.createApiKey({ name: 'expiring' });
    expect(keys.verifyApiKey(created.key).ok).toBe(true);

    await keys.updateApiKeyExpiry(created.id, Date.now() - 1000);
    expect(keys.verifyApiKey(created.key)).toEqual({ ok: false, reason: 'expired' });

    await keys.updateApiKeyExpiry(created.id, Date.now() + 60_000);
    expect(keys.verifyApiKey(created.key).ok).toBe(true);
  });

  test('null clears the expiry entirely', async () => {
    const created = await keys.createApiKey({ name: 'temporary', expiresInDays: 1 });
    expect(created.expiresAt).not.toBeNull();

    const updated = await keys.updateApiKeyExpiry(created.id, null);
    expect(updated?.expiresAt).toBeNull();
    expect(keys.verifyApiKey(created.key).ok).toBe(true);
  });

  test('revocation still wins, so an expiry edit cannot revive a key', async () => {
    const created = await keys.createApiKey({ name: 'revoked-then-extended' });
    await keys.revokeApiKey(created.id);

    await keys.updateApiKeyExpiry(created.id, Date.now() + 60_000);
    expect(keys.verifyApiKey(created.key)).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('HTTP surface', () => {
  test('rotate returns the plaintext once, expiry accepts a timestamp or null', async () => {
    const created = await keys.createApiKey({ name: 'over-http' });

    const rotateRes = await route(`/api/api-keys/${created.id}/rotate`, 'POST');
    expect(rotateRes?.status).toBe(200);
    const rotated = await rotateRes!.json();
    expect(rotated.key).toStartWith('sk-nou-');
    expect(keys.verifyApiKey(rotated.key).ok).toBe(true);

    const when = Date.now() + 86_400_000;
    const patchRes = await route(`/api/api-keys/${created.id}/expiry`, 'PATCH', { expiresAt: when });
    expect(patchRes?.status).toBe(200);
    expect((await patchRes!.json()).expiresAt).toBe(when);

    const clearRes = await route(`/api/api-keys/${created.id}/expiry`, 'PATCH', { expiresAt: null });
    expect((await clearRes!.json()).expiresAt).toBeNull();

    // The listing never carries a plaintext key, only the prefix.
    const list = await (await route('/api/api-keys'))!.json();
    expect(list.keys.every((entry: any) => entry.key === undefined)).toBe(true);
  });

  test('rejects a nonsense expiry instead of storing it', async () => {
    const created = await keys.createApiKey({ name: 'bad-input' });

    const res = await route(`/api/api-keys/${created.id}/expiry`, 'PATCH', { expiresAt: 'tomorrow' });
    expect(res?.status).toBe(400);

    const listed = (await (await route('/api/api-keys'))!.json()).keys.find(
      (entry: any) => entry.id === created.id,
    );
    expect(listed.expiresAt).toBeNull();
  });

  test('a revoked key rotated over HTTP is a 409, a missing one a 404', async () => {
    const created = await keys.createApiKey({ name: 'http-revoked' });
    await keys.revokeApiKey(created.id);

    expect((await route(`/api/api-keys/${created.id}/rotate`, 'POST'))?.status).toBe(409);
    expect((await route('/api/api-keys/nope/rotate', 'POST'))?.status).toBe(404);
    expect((await route('/api/api-keys/nope/expiry', 'PATCH', { expiresAt: null }))?.status).toBe(404);
  });
});
