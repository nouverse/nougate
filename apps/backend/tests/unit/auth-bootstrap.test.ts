import { expect, test, describe, beforeAll, afterAll } from 'bun:test';
import { rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * The bootstrap account has no fallback credential.
 *
 * This file owns its own database precisely so it can watch an *empty* user
 * table stay empty: the seeding path only runs when there are no users, so the
 * refusals below cannot be observed from a suite that already has one.
 *
 * The behaviour under test is the whole point of the change — a gateway with a
 * built-in username and password is reachable by anyone who read its README, so
 * a misconfigured deployment must lock everybody out rather than let anybody in.
 */

const STATE_DIR = mkdtempSync(join(tmpdir(), 'nougate-auth-bootstrap-'));

process.env.NOUGATE_DB_PATH = join(STATE_DIR, 'bootstrap-test.db');
process.env.SESSION_SECRET_FILE = join(STATE_DIR, '.session-secret');
process.env.SESSION_SECRET = 'test-session-secret-abcdefghijklmnop';

// Deliberately absent for the first tests.
delete process.env.INITIAL_ADMIN_USERNAME;
delete process.env.INITIAL_ADMIN_PASSWORD;

const { loadProxyConfig } = await import('@/config/manager');
const { initDb, closeDb } = await import('@/core/db');
const users = await import('@/auth/users');

beforeAll(async () => {
  await loadProxyConfig();
  await initDb();
});

afterAll(async () => {
  await closeDb();
  rmSync(STATE_DIR, { recursive: true, force: true });
});

describe('Bootstrap account without INITIAL_ADMIN_*', () => {
  test('creates nobody when neither variable is set', async () => {
    await users.initUsers();
    expect(await users.countUsers()).toBe(0);
  });

  test('there is no built-in credential to fall back to', async () => {
    expect(await users.verifyCredentials('admin', 'admin123')).toBeNull();
    expect(await users.getUserByUsername('admin')).toBeNull();
  });

  test('creates nobody when only the username is set', async () => {
    process.env.INITIAL_ADMIN_USERNAME = 'halfway';
    await users.initUsers();
    expect(await users.countUsers()).toBe(0);
  });

  test('creates nobody when only the password is set', async () => {
    delete process.env.INITIAL_ADMIN_USERNAME;
    process.env.INITIAL_ADMIN_PASSWORD = 'a-good-password';
    await users.initUsers();
    expect(await users.countUsers()).toBe(0);
  });

  test('creates nobody when either value is blank', async () => {
    process.env.INITIAL_ADMIN_USERNAME = '   ';
    process.env.INITIAL_ADMIN_PASSWORD = 'a-good-password';
    await users.initUsers();
    expect(await users.countUsers()).toBe(0);
  });
});

describe('Bootstrap account with an unusable username', () => {
  test('refuses a username with a space, which could never be typed back', async () => {
    process.env.INITIAL_ADMIN_USERNAME = 'has a space';
    process.env.INITIAL_ADMIN_PASSWORD = 'a-good-password';
    await users.initUsers();
    expect(await users.countUsers()).toBe(0);
  });

  test('refuses a username below the length floor', async () => {
    process.env.INITIAL_ADMIN_USERNAME = 'ab';
    process.env.INITIAL_ADMIN_PASSWORD = 'a-good-password';
    await users.initUsers();
    expect(await users.countUsers()).toBe(0);
  });
});

describe('Bootstrap account with valid INITIAL_ADMIN_*', () => {
  // Deliberately a single-character password: shorter than MIN_PASSWORD_LENGTH,
  // and accepted anyway. The policy stops *users* picking something weak in a
  // form; this value comes from whoever runs the deployment, and refusing it
  // would only mean a gateway that will not start.
  //
  // Only one account can ever be created here — the seeding path stops once the
  // table is non-empty, and deleteUser refuses to remove the last user — so this
  // one test carries every property of a successful bootstrap.
  test('creates exactly that account, ready to sign in', async () => {
    process.env.INITIAL_ADMIN_USERNAME = 'Operator';
    process.env.INITIAL_ADMIN_PASSWORD = 'x';
    await users.initUsers();

    expect(await users.countUsers()).toBe(1);

    // Usernames are normalised the same way sign-in normalises them, so a
    // capitalised value in .env does not become an account nobody can reach.
    const created = await users.getUserByUsername('operator');
    expect(created).not.toBeNull();
    expect(created!.mustChangePassword).toBe(false);
    expect(await users.verifyCredentials('operator', 'x')).not.toBeNull();
  });

  test('is not a password reset — a later change to the variables is ignored', async () => {
    process.env.INITIAL_ADMIN_USERNAME = 'someone-else';
    process.env.INITIAL_ADMIN_PASSWORD = 'another-password';
    await users.initUsers();

    expect(await users.countUsers()).toBe(1);
    expect(await users.getUserByUsername('someone-else')).toBeNull();
  });
});
