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

/**
 * The Playground reaches keys by id, because it can never reach them by secret.
 *
 * Keys are stored hashed, so a signed-in operator cannot be handed one back — the dashboard names a
 * key to attribute usage to and lets its session do the authorising. That only holds if a lookup by
 * id refuses exactly what `verifyApiKey` refuses; a revoked key that stays findable here is a
 * revocation that does not revoke.
 */
describe('Finding a key by id', () => {
  test('finds a live key and refuses a revoked one', async () => {
    const created = await keys.createApiKey({ name: 'playground' });

    const found = keys.findApiKeyById(created.id);
    expect(found?.id).toBe(created.id);
    expect(found?.name).toBe('playground');
    // The secret must not be reachable this way, whatever else changes.
    expect((found as Record<string, unknown> | null)?.key).toBeUndefined();

    // Revoked keys never enter the verification cache — it is loaded `WHERE revoked = 0` — so a
    // lookup stops finding them entirely rather than returning one flagged as dead.
    await keys.revokeApiKey(created.id);
    expect(keys.findApiKeyById(created.id)).toBeNull();
  });

  test('an expired key is still found, and is the caller\'s job to refuse', async () => {
    // Expiry is not filtered out of the cache the way revocation is, so this is the check that
    // actually runs in the router. Both refusals live next to each other there for that reason.
    const created = await keys.createApiKey({ name: 'playground-expired', expiresInDays: 1 });
    await keys.updateApiKeyExpiry(created.id, Date.now() - 1000);

    const found = keys.findApiKeyById(created.id);
    expect(found).not.toBeNull();
    expect(found!.expiresAt).toBeLessThan(Date.now());
  });

  test('an id that matches nothing is null, not a throw', () => {
    expect(keys.findApiKeyById('no-such-key')).toBeNull();
    expect(keys.findApiKeyById('')).toBeNull();
  });

  test('survives a rotation, because the id is the identity the dashboard holds', async () => {
    const created = await keys.createApiKey({ name: 'playground-rotated' });
    const rotated = await keys.rotateApiKey(created.id);
    expect(rotated.ok).toBe(true);

    // A Playground selection made before the rotation still names a usable key afterwards.
    expect(keys.findApiKeyById(created.id)?.id).toBe(created.id);
  });
});

/**
 * Renaming a key.
 *
 * The name is what a request without an explicit `x-client-id` is attributed to, so this is not a
 * cosmetic field — a rename that failed to reach the verification cache would keep billing traffic
 * to the old label until something else happened to invalidate it.
 */
describe('Renaming a key', () => {
  test('changes the name the next request is attributed to', async () => {
    const created = await keys.createApiKey({ name: 'old-name' });

    const renamed = await keys.renameApiKey(created.id, 'new-name');
    expect(renamed?.name).toBe('new-name');

    // The cache is what every proxy request reads; a rename that only touched the row would leave
    // `apiKeyName` stale for the life of the process.
    const verified = keys.verifyApiKey(created.key);
    expect(verified.ok).toBe(true);
    if (verified.ok) expect(verified.record.name).toBe('new-name');
  });

  test('keeps the identity, the secret and the counters', async () => {
    const created = await keys.createApiKey({ name: 'before' });
    keys.touchApiKey(created.id);
    await keys.flushApiKeyUsage();

    const renamed = await keys.renameApiKey(created.id, 'after');
    expect(renamed?.id).toBe(created.id);
    expect(renamed?.keyPrefix).toBe(created.keyPrefix);
    expect(renamed?.requestCount).toBe(1);
    // Renaming is not rotating: the secret that was working still works.
    expect(keys.verifyApiKey(created.key).ok).toBe(true);
  });

  test('trims, and refuses a name that is only whitespace', async () => {
    const created = await keys.createApiKey({ name: 'trim-me' });

    expect((await keys.renameApiKey(created.id, '  padded  '))?.name).toBe('padded');
    // Empty is a mistake, not an instruction to fall back to "Unnamed key" the way creation does —
    // the operator typed into a field that already had a name in it.
    await expect(keys.renameApiKey(created.id, '   ')).rejects.toThrow(/name is required/i);
    expect(keys.findApiKeyById(created.id)?.name).toBe('padded');
  });

  test('an id that matches nothing is null, so the caller can answer 404', async () => {
    expect(await keys.renameApiKey('no-such-key', 'whatever')).toBeNull();
  });

  test('a revoked key can still be renamed, because history keeps its label', async () => {
    // Revoked keys stay in the dashboard with their usage attached; being unable to fix a typo on
    // one would mean the metrics carry that typo forever.
    const created = await keys.createApiKey({ name: 'typoo' });
    await keys.revokeApiKey(created.id);

    expect((await keys.renameApiKey(created.id, 'typo-fixed'))?.name).toBe('typo-fixed');
  });
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
