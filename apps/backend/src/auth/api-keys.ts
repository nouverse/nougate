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
  const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(SECRET_BYTES)))
    .toString('base64url');
  const key = `${KEY_PREFIX}${secret}`;
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
    keyHash: sha256(key),
    // Enough of the key to recognize it in a list, never enough to use it.
    keyPrefix: `${key.slice(0, KEY_PREFIX.length + 6)}...${key.slice(-4)}`,
    createdAt,
    expiresAt,
    allowedProviders: allowedProviders.length ? JSON.stringify(allowedProviders) : null,
  });

  await refreshCache();

  return {
    id,
    name,
    key,
    keyPrefix: `${key.slice(0, KEY_PREFIX.length + 6)}...${key.slice(-4)}`,
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
