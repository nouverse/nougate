import { eq, sql } from 'drizzle-orm';
import { getDb, t } from '@/core/db';

export interface ApiKeyRecord {
  id: string;
  name: string;
  keyPrefix: string;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
  revoked: boolean;
  requestCount: number;
  /** Empty means every provider is allowed. */
  allowedProviders: string[];
}

export interface CreatedApiKey extends ApiKeyRecord {
  /** Only ever returned once, at creation time — the hash is what we store. */
  key: string;
}

const KEY_PREFIX = 'sk-nou-';
const SECRET_BYTES = 32;

/**
 * Hash cache keyed by the SHA-256 of the presented key, so verifying a request
 * is a hash plus a Map lookup instead of a SQLite round-trip on the hot path.
 */
let cache: Map<string, ApiKeyRecord> | null = null;

function sha256(value: string): string {
  return new Bun.CryptoHasher('sha256').update(value).digest('hex');
}

/**
 * Mint a secret and everything derived from it. Shared by creation and rotation
 * so a rotated key is indistinguishable from a freshly created one.
 */
function mintSecret(): { key: string; keyHash: string; keyPrefix: string } {
  const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(SECRET_BYTES)))
    .toString('base64url');
  const key = `${KEY_PREFIX}${secret}`;

  return {
    key,
    keyHash: sha256(key),
    // Enough of the key to recognize it in a list, never enough to use it.
    keyPrefix: `${key.slice(0, KEY_PREFIX.length + 6)}...${key.slice(-4)}`,
  };
}

function rowToRecord(row: any): ApiKeyRecord {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.keyPrefix,
    createdAt: Number(row.createdAt),
    lastUsedAt: row.lastUsedAt === null || row.lastUsedAt === undefined ? null : Number(row.lastUsedAt),
    expiresAt: row.expiresAt === null || row.expiresAt === undefined ? null : Number(row.expiresAt),
    revoked: row.revoked === 1,
    requestCount: row.requestCount ?? 0,
    allowedProviders: row.allowedProviders ? JSON.parse(row.allowedProviders) : [],
  };
}

/**
 * Verification runs on every proxy request, so it reads an in-memory map rather
 * than the database. The map is (re)built here and invalidated on any mutation.
 */
async function loadCache(): Promise<Map<string, ApiKeyRecord>> {
  if (cache) {
    return cache;
  }

  const rows = await getDb().select().from(t.apiKeys).where(eq(t.apiKeys.revoked, 0));
  const next = new Map<string, ApiKeyRecord>();
  for (const row of rows) {
    next.set(row.keyHash, rowToRecord(row));
  }

  cache = next;
  return cache;
}

/**
 * Rebuild the verification map after a mutation.
 *
 * It is refreshed rather than dropped: `verifyApiKey` is synchronous because it
 * runs on every proxy request, so a null cache would reject every key until
 * something happened to reload it.
 */
async function refreshCache(): Promise<void> {
  cache = null;
  await loadCache();
}

/**
 * Warm the verification cache during startup.
 */
export async function initApiKeys(): Promise<void> {
  await loadCache();
}

/**
 * Mint a new gateway key. The plaintext is returned exactly once.
 */
export async function createApiKey(options: {
  name: string;
  expiresInDays?: number | null;
  allowedProviders?: string[];
}): Promise<CreatedApiKey> {
  const name = options.name?.trim() || 'Unnamed key';
  const { key, keyHash, keyPrefix } = mintSecret();
  const id = crypto.randomUUID();
  const createdAt = Date.now();
  const expiresAt =
    options.expiresInDays && options.expiresInDays > 0
      ? createdAt + options.expiresInDays * 24 * 60 * 60 * 1000
      : null;
  const allowedProviders = options.allowedProviders?.filter(Boolean) ?? [];

  await getDb().insert(t.apiKeys).values({
    id,
    name,
    keyHash,
    keyPrefix,
    createdAt,
    expiresAt,
    allowedProviders: allowedProviders.length ? JSON.stringify(allowedProviders) : null,
  });

  await refreshCache();

  return {
    id,
    name,
    key,
    keyPrefix,
    createdAt,
    lastUsedAt: null,
    expiresAt,
    revoked: false,
    requestCount: 0,
    allowedProviders,
  };
}

/**
 * List every key, including revoked ones, for the dashboard.
 */
export async function listApiKeys(): Promise<ApiKeyRecord[]> {
  const rows = await getDb().select().from(t.apiKeys).orderBy(sql`${t.apiKeys.createdAt} DESC`);
  return rows.map(rowToRecord);
}

/**
 * Revoke a key without deleting its usage history.
 */
export async function revokeApiKey(id: string): Promise<boolean> {
  const [existing] = await getDb().select({ id: t.apiKeys.id }).from(t.apiKeys).where(eq(t.apiKeys.id, id));
  if (!existing) {
    return false;
  }

  await getDb().update(t.apiKeys).set({ revoked: 1 }).where(eq(t.apiKeys.id, id));
  await refreshCache();
  return true;
}

export type ApiKeyRotation =
  | { ok: true; key: CreatedApiKey }
  | { ok: false; reason: 'not-found' | 'revoked' };

/**
 * Replace a key's secret in place.
 *
 * The row id never changes, which is the entire point: usage rows reference the
 * id, so rotating keeps one continuous history instead of splitting a client's
 * spend across an old and a new key. `requestCount` and `lastUsedAt` carry over
 * for the same reason — this is the same key with a new secret, not a new key.
 *
 * The old secret stops working the moment the cache is refreshed. There is no
 * grace period: two live secrets for one key would mean a leaked key stays usable
 * after the rotation meant to retire it.
 */
export async function rotateApiKey(id: string): Promise<ApiKeyRotation> {
  // Usage counters buffer in memory, so the row would otherwise report a stale
  // request count in the record this returns.
  await flushApiKeyUsage();

  const [existing] = await getDb().select().from(t.apiKeys).where(eq(t.apiKeys.id, id));
  if (!existing) {
    return { ok: false, reason: 'not-found' };
  }
  if (existing.revoked === 1) {
    // Rotating would quietly hand back a secret that verification still rejects.
    return { ok: false, reason: 'revoked' };
  }

  const { key, keyHash, keyPrefix } = mintSecret();
  await getDb().update(t.apiKeys).set({ keyHash, keyPrefix }).where(eq(t.apiKeys.id, id));
  await refreshCache();

  return { ok: true, key: { ...rowToRecord({ ...existing, keyPrefix }), key } };
}

/**
 * Change when a key expires, or clear the expiry entirely with `null`.
 *
 * Absolute rather than "in N days" like creation: this backs an edit control, and
 * a relative offset there would silently mean something different depending on
 * when it was submitted. A timestamp in the past is accepted — that is how you
 * expire a key immediately without revoking it.
 *
 * Revocation still wins in `verifyApiKey`, so this cannot bring a revoked key
 * back to life.
 */
export async function updateApiKeyExpiry(
  id: string,
  expiresAt: number | null,
): Promise<ApiKeyRecord | null> {
  await flushApiKeyUsage();

  const [existing] = await getDb().select().from(t.apiKeys).where(eq(t.apiKeys.id, id));
  if (!existing) {
    return null;
  }

  await getDb().update(t.apiKeys).set({ expiresAt }).where(eq(t.apiKeys.id, id));
  await refreshCache();

  return rowToRecord({ ...existing, expiresAt });
}

/**
 * Permanently delete a key row.
 */
export async function deleteApiKey(id: string): Promise<boolean> {
  const [existing] = await getDb().select({ id: t.apiKeys.id }).from(t.apiKeys).where(eq(t.apiKeys.id, id));
  if (!existing) {
    return false;
  }

  await getDb().delete(t.apiKeys).where(eq(t.apiKeys.id, id));
  await refreshCache();
  return true;
}

/**
 * Extract a gateway key from either the OpenAI (`Authorization: Bearer`) or the
 * Anthropic (`x-api-key`) convention, so both client styles work unchanged.
 */
export function extractApiKey(req: Request): string | null {
  const header = req.headers.get('authorization');
  if (header) {
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  const anthropicHeader = req.headers.get('x-api-key');
  if (anthropicHeader) {
    return anthropicHeader.trim();
  }

  return null;
}

/**
 * A key by its id, for a caller that already proved who it is another way.
 *
 * The dashboard's Playground is the case this exists for. Keys are stored as a hash, so nothing can
 * hand a signed-in operator the secret back — but the Playground does not need the secret, only a
 * key to attribute its usage to. Reads the same warm cache `verifyApiKey` uses, so it stays cheap
 * and cannot disagree with it about whether a key is revoked.
 */
export function findApiKeyById(id: string): ApiKeyRecord | null {
  if (!id || !cache) return null;
  for (const record of cache.values()) {
    if (record.id === id) return record;
  }
  return null;
}

export type ApiKeyVerification =
  | { ok: true; record: ApiKeyRecord }
  | { ok: false; reason: 'missing' | 'invalid' | 'revoked' | 'expired' };

/**
 * Verify a presented key. Cheap enough to sit on every proxy request.
 */
export function verifyApiKey(raw: string | null): ApiKeyVerification {
  if (!raw) {
    return { ok: false, reason: 'missing' };
  }

  // Synchronous on purpose: this sits on every proxy request. `initApiKeys()`
  // warms the map at boot and every mutation invalidates it.
  const record = cache?.get(sha256(raw));
  if (!record) {
    return { ok: false, reason: 'invalid' };
  }
  if (record.revoked) {
    return { ok: false, reason: 'revoked' };
  }
  if (record.expiresAt && record.expiresAt < Date.now()) {
    return { ok: false, reason: 'expired' };
  }

  return { ok: true, record };
}

/** Pending per-key usage counters, flushed on a timer instead of per request. */
const pendingUsage = new Map<string, { count: number; lastUsedAt: number }>();
let usageTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Write buffered key usage counters to SQLite.
 */
export async function flushApiKeyUsage(): Promise<void> {
  if (pendingUsage.size === 0) {
    return;
  }

  const batch = Array.from(pendingUsage.entries());
  pendingUsage.clear();

  try {
    for (const [id, usage] of batch) {
      await getDb()
        .update(t.apiKeys)
        .set({
          lastUsedAt: usage.lastUsedAt,
          requestCount: sql`${t.apiKeys.requestCount} + ${usage.count}`,
        })
        .where(eq(t.apiKeys.id, id));
    }
  } catch (error) {
    console.warn('[ApiKeys] Failed to flush key usage:', error);
  }
}

/**
 * Record that a key was used. Buffered in memory so the proxy hot path never
 * waits on a database write.
 */
export function touchApiKey(id: string): void {
  const now = Date.now();
  const existing = pendingUsage.get(id);

  if (existing) {
    existing.count += 1;
    existing.lastUsedAt = now;
  } else {
    pendingUsage.set(id, { count: 1, lastUsedAt: now });
  }

  const cached = cache;
  if (cached) {
    for (const record of cached.values()) {
      if (record.id === id) {
        record.lastUsedAt = now;
        record.requestCount += 1;
        break;
      }
    }
  }

  if (!usageTimer) {
    usageTimer = setInterval(() => void flushApiKeyUsage(), 30_000);
    usageTimer.unref?.();
  }
}
