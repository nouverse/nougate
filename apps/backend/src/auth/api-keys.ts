import { dbAll, dbPrepare, dbRun, dbTransaction } from '@/core/db';
import { getProxyConfig } from '@/config/manager';

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
    keyPrefix: row.key_prefix,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at ?? null,
    expiresAt: row.expires_at ?? null,
    revoked: row.revoked === 1,
    requestCount: row.request_count ?? 0,
    allowedProviders: row.allowed_providers ? JSON.parse(row.allowed_providers) : [],
  };
}

function loadCache(): Map<string, ApiKeyRecord> {
  if (cache) {
    return cache;
  }

  const rows = dbAll('SELECT * FROM api_keys WHERE revoked = 0');
  const next = new Map<string, ApiKeyRecord>();
  for (const row of rows) {
    next.set(row.key_hash, rowToRecord(row));
  }

  cache = next;
  return cache;
}

function invalidateCache(): void {
  cache = null;
}

/**
 * Warm the verification cache during startup.
 */
export function initApiKeys(): void {
  loadCache();
}

/**
 * Whether gateway key auth is switched on in config.
 */
export function isApiKeyAuthEnabled(): boolean {
  try {
    return getProxyConfig().apiKeys?.enabled === true;
  } catch {
    return false;
  }
}

/**
 * Mint a new gateway key. The plaintext is returned exactly once.
 */
export function createApiKey(options: {
  name: string;
  expiresInDays?: number | null;
  allowedProviders?: string[];
}): CreatedApiKey {
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

  dbRun(
    `INSERT INTO api_keys (id, name, key_hash, key_prefix, created_at, expires_at, allowed_providers)
     VALUES ($id, $name, $hash, $prefix, $createdAt, $expiresAt, $allowedProviders)`,
    {
      $id: id,
      $name: name,
      $hash: sha256(key),
      // Enough of the key to recognize it in a list, never enough to use it.
      $prefix: `${key.slice(0, KEY_PREFIX.length + 6)}...${key.slice(-4)}`,
      $createdAt: createdAt,
      $expiresAt: expiresAt,
      $allowedProviders: allowedProviders.length ? JSON.stringify(allowedProviders) : null,
    },
  );

  invalidateCache();

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
export function listApiKeys(): ApiKeyRecord[] {
  const rows = dbAll('SELECT * FROM api_keys ORDER BY created_at DESC');
  return rows.map(rowToRecord);
}

/**
 * Revoke a key without deleting its usage history.
 */
export function revokeApiKey(id: string): boolean {
  const result = dbRun('UPDATE api_keys SET revoked = 1 WHERE id = $id', { $id: id });
  invalidateCache();
  return result.changes > 0;
}

/**
 * Permanently delete a key row.
 */
export function deleteApiKey(id: string): boolean {
  const result = dbRun('DELETE FROM api_keys WHERE id = $id', { $id: id });
  invalidateCache();
  return result.changes > 0;
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

  const record = loadCache().get(sha256(raw));
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
export function flushApiKeyUsage(): void {
  if (pendingUsage.size === 0) {
    return;
  }

  const batch = Array.from(pendingUsage.entries());
  pendingUsage.clear();

  try {
    const statement = dbPrepare(
      `UPDATE api_keys
       SET last_used_at = $lastUsedAt, request_count = request_count + $count
       WHERE id = $id`,
    );
    const write = dbTransaction(() => {
      for (const [id, usage] of batch) {
        statement.run({ $id: id, $count: usage.count, $lastUsedAt: usage.lastUsedAt });
      }
    });
    write();
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
    usageTimer = setInterval(() => flushApiKeyUsage(), 30_000);
    usageTimer.unref?.();
  }
}
