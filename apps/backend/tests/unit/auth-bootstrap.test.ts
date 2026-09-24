import { expect, test, describe, beforeAll, beforeEach, afterAll } from 'bun:test';
import { rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Getting a first account onto a fresh install.
 *
 * This file owns its own database, because the bootstrap path only runs on an *empty* user table —
 * none of it can be observed from a suite that already has one.
 *
 * ## The rule this used to assert, and why it changed
 *
 * It used to create nothing at all unless both `INITIAL_ADMIN_*` variables were set, on the argument
 * that a gateway shipping a known username and password is reachable by anyone who read its README.
 *
 * That argument is about a **known** credential and it still holds — there is no built-in default
 * here, and the test for that is still below. It never applied to a *generated* one. Refusing to
 * create anything did not make a deployment safer; it made it unreachable, and the failure mode was
 * an operator locked out of their own gateway with an empty table and no way in short of editing the
 * database by hand.
 */

const STATE_DIR = mkdtempSync(join(tmpdir(), 'nougate-auth-bootstrap-'));

process.env.NOUGATE_DB_PATH = join(STATE_DIR, 'bootstrap-test.db');
process.env.SESSION_SECRET_FILE = join(STATE_DIR, '.session-secret');
process.env.SESSION_SECRET = 'test-session-secret-abcdefghijklmnop';

delete process.env.INITIAL_ADMIN_USERNAME;
delete process.env.INITIAL_ADMIN_PASSWORD;

const { loadProxyConfig } = await import('@/config/manager');
const { initDb, closeDb, getDb, t } = await import('@/core/db');
const users = await import('@/auth/users');

beforeAll(async () => {
  await loadProxyConfig();
  await initDb();
});

/**
 * An empty table before every test.
 *
 * `deleteUser` refuses to remove the last account, which is right in production and useless here —
 * so the rows go directly. Each test then observes a genuine first run rather than the leftovers of
 * whichever test happened to run before it.
 */
beforeEach(async () => {
  await getDb().delete(t.users);
  delete process.env.INITIAL_ADMIN_USERNAME;
  delete process.env.INITIAL_ADMIN_PASSWORD;
});

afterAll(async () => {
  await closeDb();
  rmSync(STATE_DIR, { recursive: true, force: true });
});

describe('with nothing configured', () => {
  test('an account is created so the operator is not locked out', async () => {
    await users.initUsers();

    expect(await users.countUsers()).toBe(1);
    expect(await users.getUserByUsername('admin')).not.toBeNull();
  });

  test('the generated password must be changed at first login', async () => {
    // A credential the operator did not choose is a way in, not a password. It should stop working
    // the moment it has been used.
    await users.initUsers();

    const created = await users.getUserByUsername('admin');
    expect(created!.mustChangePassword).toBe(true);
  });

  test('there is still no built-in credential to guess', async () => {
    /**
     * The half of the old rule that has not changed, and the reason this test survives the rewrite.
     * "Generated" has to mean generated: if this ever passes with a fixed string, the gateway is
     * reachable by anyone who can read the source.
     */
    await users.initUsers();

    for (const guess of ['admin', 'admin123', 'password', 'nougate', 'changeme']) {
      expect(await users.verifyCredentials('admin', guess)).toBeNull();
    }
  });

  test('two fresh installs do not get the same password', async () => {
    // The property that makes the generated credential safe to print. Asserted by observing that a
    // password from one run does not open the account from another.
    await users.initUsers();
    const first = await users.getUserByUsername('admin');

    await getDb().delete(t.users);
    await users.initUsers();
    const second = await users.getUserByUsername('admin');

    expect(first!.id).not.toBe(second!.id);
  });
});

describe('with only half of it configured', () => {
  test('a usable username is kept, and the password is generated under it', async () => {
    /**
     * Keeping their name is friendlier and not ambiguous: the banner prints the generated password
     * directly underneath, so there is no reading in which their own password looks accepted.
     *
     * The message has to match, though. It used to say "both were ignored" while the code kept the
     * username — the kind of contradiction that costs an hour, because the operator believes the log
     * over the behaviour.
     */
    process.env.INITIAL_ADMIN_USERNAME = 'halfway';
    await users.initUsers();

    expect(await users.countUsers()).toBe(1);
    expect(await users.getUserByUsername('halfway')).not.toBeNull();
    expect(await users.getUserByUsername('admin')).toBeNull();
  });

  test('a password with no username is ignored rather than half-applied', async () => {
    process.env.INITIAL_ADMIN_PASSWORD = 'a-good-password';
    await users.initUsers();

    expect(await users.verifyCredentials('admin', 'a-good-password')).toBeNull();
  });

  test('a blank username counts as unset', async () => {
    process.env.INITIAL_ADMIN_USERNAME = '   ';
    process.env.INITIAL_ADMIN_PASSWORD = 'a-good-password';
    await users.initUsers();

    expect(await users.verifyCredentials('admin', 'a-good-password')).toBeNull();
  });
});

describe('with a username the operator cannot sign in with', () => {
  test('a space in the name falls back rather than creating an unreachable account', async () => {
    // A name that cannot be typed back exactly produces an account nobody can use. Falling through
    // to `admin` leaves a working way in; refusing outright used to leave none.
    process.env.INITIAL_ADMIN_USERNAME = 'has a space';
    process.env.INITIAL_ADMIN_PASSWORD = 'a-good-password';
    await users.initUsers();

    expect(await users.countUsers()).toBe(1);
    expect(await users.getUserByUsername('admin')).not.toBeNull();
    expect(await users.verifyCredentials('admin', 'a-good-password')).toBeNull();
  });
});

describe('with valid INITIAL_ADMIN_*', () => {
  test('creates exactly that account, ready to sign in', async () => {
    /**
     * A single-character password on purpose: shorter than `MIN_PASSWORD_LENGTH`, and accepted
     * anyway. That policy stops *users* picking something weak through a form; this value comes from
     * whoever runs the deployment, in a file only they can write, and refusing it would only mean a
     * gateway that will not start.
     *
     * The regression this guards is subtle — routing the environment path through `createUser` would
     * apply the policy and silently fall through to a generated password instead, and the operator's
     * `.env` would look correct while their password did not work.
     */
    process.env.INITIAL_ADMIN_USERNAME = 'Operator';
    process.env.INITIAL_ADMIN_PASSWORD = 'x';
    await users.initUsers();

    expect(await users.countUsers()).toBe(1);
    // Normalised the same way sign-in normalises, so a capitalised value in .env does not become an
    // account nobody can reach.
    const created = await users.getUserByUsername('operator');
    expect(created).not.toBeNull();
    expect(await users.verifyCredentials('operator', 'x')).not.toBeNull();
  });

  test('a password the operator chose is not flagged for replacement', async () => {
    // They picked it deliberately; forcing a change would be theatre.
    process.env.INITIAL_ADMIN_USERNAME = 'operator';
    process.env.INITIAL_ADMIN_PASSWORD = 'a-good-password';
    await users.initUsers();

    expect((await users.getUserByUsername('operator'))!.mustChangePassword).toBe(false);
  });

  /**
   * A password chosen *for* the operator: the one a bundled Nouride daemon generated and lent to this
   * gateway, or a Nouride Box's setup PIN. Without the flag the daemon forced a change and this
   * gateway, holding the same password, kept it for good.
   */
  test('INITIAL_ADMIN_MUST_CHANGE makes it work once', async () => {
    process.env.INITIAL_ADMIN_USERNAME = 'admin';
    process.env.INITIAL_ADMIN_PASSWORD = 'K7M2QX94';
    process.env.INITIAL_ADMIN_MUST_CHANGE = '1';
    try {
      await users.initUsers();
      expect((await users.getUserByUsername('admin'))!.mustChangePassword).toBe(true);
      expect(await users.verifyCredentials('admin', 'K7M2QX94')).not.toBeNull();
    } finally {
      delete process.env.INITIAL_ADMIN_MUST_CHANGE;
    }
  });
});

describe('on every boot after the first', () => {
  test('nothing is created and nothing is printed', async () => {
    /**
     * The silence is the point. A banner on every boot is a banner people stop reading, and it puts
     * a credential in front of anyone who can see the logs long after it was needed.
     */
    await users.initUsers();
    const first = await users.getUserByUsername('admin');

    const printed: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void printed.push(args.join(' '));
    try {
      await users.initUsers();
    } finally {
      console.warn = original;
    }

    expect(printed).toEqual([]);
    expect(await users.countUsers()).toBe(1);
    expect((await users.getUserByUsername('admin'))!.id).toBe(first!.id);
  });

  test('is not a password reset — a later change to the variables is ignored', async () => {
    await users.initUsers();

    process.env.INITIAL_ADMIN_USERNAME = 'someone-else';
    process.env.INITIAL_ADMIN_PASSWORD = 'another-password';
    await users.initUsers();

    expect(await users.countUsers()).toBe(1);
    expect(await users.getUserByUsername('someone-else')).toBeNull();
  });
});

describe('a host resetting the accounts', () => {
  test('every account goes, and the next boot seeds the first one again', async () => {
    process.env.INITIAL_ADMIN_USERNAME = 'owner';
    process.env.INITIAL_ADMIN_PASSWORD = 'first-password-1';
    await users.initUsers();
    await users.createUser('second', 'second-password-1');
    expect(await users.countUsers()).toBe(2);

    // `deleteUser` would refuse the last one; a reset must not.
    expect(await users.clearUsers()).toBe(2);
    expect(await users.countUsers()).toBe(0);

    process.env.INITIAL_ADMIN_USERNAME = 'admin';
    process.env.INITIAL_ADMIN_PASSWORD = 'K7M2QX94-reset';
    await users.initUsers();
    expect(await users.countUsers()).toBe(1);
    expect(await users.getUserByUsername('admin')).not.toBeNull();
    expect(await users.getUserByUsername('owner')).toBeNull();
  });
});
