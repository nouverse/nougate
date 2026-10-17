import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const STATE_DIR = mkdtempSync(join(tmpdir(), 'nougate-password-cost-'));
process.env.NOUGATE_DB_PATH = join(STATE_DIR, 'password-cost.db');
process.env.SESSION_SECRET_FILE = join(STATE_DIR, '.session-secret');
process.env.SESSION_SECRET = 'test-session-secret-abcdefghijklmnop';
delete process.env.INITIAL_ADMIN_USERNAME;
delete process.env.INITIAL_ADMIN_PASSWORD;

const { loadProxyConfig } = await import('@/config/manager');
const { initDb, closeDb, getDb, t } = await import('@/core/db');
const { eq } = await import('drizzle-orm');
const users = await import('@/auth/users');

beforeAll(async () => {
  await loadProxyConfig();
  await initDb();
});

afterAll(async () => {
  await closeDb();
  rmSync(STATE_DIR, { recursive: true, force: true });
});

async function storedHash(username: string): Promise<string> {
  const [row] = await getDb().select().from(t.users).where(eq(t.users.username, username)).limit(1);
  return row!.passwordHash;
}

/**
 * The dashboard's passwords are hashed at OWASP's argon2id cost, 19 MiB — not Bun's 64 MiB default, which a hosted
 * gateway paid inside Nouride's daemon at every sign-in.
 */
describe('the cost a password is hashed at', () => {
  test('a new password is hashed at 19 MiB and two passes', async () => {
    await users.createUser('cost-new', 'a-long-password-1');
    expect(await storedHash('cost-new')).toContain('m=19456,t=2,');
  });

  test('a password hashed at the old cost still signs in, and is hashed again at the new one', async () => {
    const user = await users.createUser('cost-old', 'a-long-password-2');
    const old = await Bun.password.hash('a-long-password-2', { algorithm: 'argon2id', memoryCost: 65536, timeCost: 2 });
    await getDb().update(t.users).set({ passwordHash: old }).where(eq(t.users.id, user.id));

    expect(await users.verifyCredentials('cost-old', 'a-long-password-2')).not.toBeNull();
    const after = await storedHash('cost-old');
    expect(after).toContain('m=19456,t=2,');
    expect(await Bun.password.verify('a-long-password-2', after)).toBe(true);
  }, 30_000);

  test('a wrong password is still refused, and leaves the old hash alone', async () => {
    const user = await users.createUser('cost-wrong', 'a-long-password-3');
    const old = await Bun.password.hash('a-long-password-3', { algorithm: 'argon2id', memoryCost: 65536, timeCost: 2 });
    await getDb().update(t.users).set({ passwordHash: old }).where(eq(t.users.id, user.id));

    expect(await users.verifyCredentials('cost-wrong', 'not-the-password')).toBeNull();
    expect(await storedHash('cost-wrong')).toBe(old);
  }, 30_000);
});
