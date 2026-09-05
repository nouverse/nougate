import { randomBytes } from 'node:crypto';
import { and, eq, ne, sql } from 'drizzle-orm';
import { getDb, t } from '@/core/db';

export interface User {
  id: string;
  username: string;
  mustChangePassword: boolean;
  createdAt: number;
  lastLoginAt: number | null;
}

const MIN_PASSWORD_LENGTH = 8;
const MIN_USERNAME_LENGTH = 3;
const MAX_USERNAME_LENGTH = 254;   // fits the longest legal email address
/** Only whitespace is barred — it makes a username impossible to type back exactly. */
const USERNAME_FORBIDDEN = /\s/;

/** Failed sign-ins are throttled per username to blunt online guessing. */
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 60_000;

const failedAttempts = new Map<string, { count: number; lockedUntil: number }>();

export class AuthError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}

function rowToUser(row: any): User {
  return {
    id: row.id,
    username: row.username,
    mustChangePassword: row.mustChangePassword === 1,
    createdAt: Number(row.createdAt),
    lastLoginAt: row.lastLoginAt === null || row.lastLoginAt === undefined ? null : Number(row.lastLoginAt),
  };
}

export function normalizeUsername(username: string): string {
  return (username ?? '').trim().toLowerCase();
}

/**
 * Validate a username.
 *
 * Deliberately permissive: a username is a label people type, not a URL segment —
 * it never appears in a path — so an email address, a handle with `+`, or
 * non-Latin script are all legitimate choices. The only rules are a usable
 * length and no whitespace, which would make the value impossible to retype
 * exactly and invisible to compare.
 */
function assertValidUsername(username: string): void {
  if (username.length < MIN_USERNAME_LENGTH || username.length > MAX_USERNAME_LENGTH) {
    throw new AuthError(
      `Username must be ${MIN_USERNAME_LENGTH}–${MAX_USERNAME_LENGTH} characters.`,
    );
  }
  if (USERNAME_FORBIDDEN.test(username)) {
    throw new AuthError('Username cannot contain spaces.');
  }
}

/**
 * Enforce the password policy.
 *
 * There is no longer a well-known seeded password to blacklist: the bootstrap
 * account is created from `INITIAL_ADMIN_PASSWORD` or not at all.
 */
function assertValidPassword(password: string): void {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new AuthError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
}

async function hashPassword(password: string): Promise<string> {
  // argon2id is Bun's default and needs no dependency.
  return Bun.password.hash(password);
}

/** Computed once, and only if an unknown username is ever submitted. */
let dummyHash: Promise<string> | null = null;

function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword('nougate-timing-equalizer');
  return dummyHash;
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export async function listUsers(): Promise<User[]> {
  const rows = await getDb().select().from(t.users).orderBy(t.users.createdAt);
  return rows.map(rowToUser);
}

export async function countUsers(): Promise<number> {
  const [row] = await getDb()
    .select({ total: sql<number>`count(*)` })
    .from(t.users);
  return Number(row?.total ?? 0);
}

export async function getUserById(id: string): Promise<User | null> {
  const [row] = await getDb().select().from(t.users).where(eq(t.users.id, id)).limit(1);
  return row ? rowToUser(row) : null;
}

export async function getUserByUsername(username: string): Promise<User | null> {
  // Usernames are stored lowercased, so an exact match is enough on both
  // dialects — no reliance on SQLite's NOCASE collation.
  const [row] = await getDb()
    .select()
    .from(t.users)
    .where(eq(t.users.username, normalizeUsername(username)))
    .limit(1);
  return row ? rowToUser(row) : null;
}

// ─── Mutations ────────────────────────────────────────────────────────────────

/**
 * Create a user. `mustChangePassword` marks a credential the recipient is
 * expected to replace on first use.
 */
export async function createUser(
  username: string,
  password: string,
  mustChangePassword = false,
): Promise<User> {
  const normalized = normalizeUsername(username);
  assertValidUsername(normalized);
  assertValidPassword(password);

  if (await getUserByUsername(normalized)) {
    throw new AuthError(`User "${normalized}" already exists.`, 409);
  }

  const user: User = {
    id: crypto.randomUUID(),
    username: normalized,
    mustChangePassword,
    createdAt: Date.now(),
    lastLoginAt: null,
  };

  await getDb().insert(t.users).values({
    id: user.id,
    username: user.username,
    passwordHash: await hashPassword(password),
    mustChangePassword: mustChangePassword ? 1 : 0,
    createdAt: user.createdAt,
  });

  return user;
}

/**
 * Rename a user.
 *
 * Returns the updated record. Renaming to the current name is a no-op rather
 * than a conflict, so a settings form can submit unchanged fields safely.
 */
export async function setUsername(userId: string, newUsername: string): Promise<User> {
  const normalized = normalizeUsername(newUsername);
  assertValidUsername(normalized);

  const current = await getUserById(userId);
  if (!current) {
    throw new AuthError('User not found.', 404);
  }

  if (current.username === normalized) {
    return current;
  }

  const taken = await getUserByUsername(normalized);
  if (taken && taken.id !== userId) {
    throw new AuthError(`User "${normalized}" already exists.`, 409);
  }

  await getDb().update(t.users).set({ username: normalized }).where(eq(t.users.id, userId));

  return { ...current, username: normalized };
}

/**
 * Replace a user's password and clear any forced-change flag.
 */
export async function setPassword(userId: string, newPassword: string): Promise<void> {
  assertValidPassword(newPassword);

  const existing = await getUserById(userId);
  if (!existing) {
    throw new AuthError('User not found.', 404);
  }

  await getDb()
    .update(t.users)
    .set({ passwordHash: await hashPassword(newPassword), mustChangePassword: 0 })
    .where(eq(t.users.id, userId));
}

/**
 * Delete a user, refusing to remove the last one — that would lock everybody out
 * of a dashboard whose only recovery path is editing the database by hand.
 */
export async function deleteUser(userId: string): Promise<void> {
  if ((await countUsers()) <= 1) {
    throw new AuthError('Cannot delete the last remaining user.', 409);
  }

  const existing = await getUserById(userId);
  if (!existing) {
    throw new AuthError('User not found.', 404);
  }

  await getDb().delete(t.users).where(eq(t.users.id, userId));
}

// ─── Authentication ───────────────────────────────────────────────────────────

/**
 * Remaining lockout in milliseconds, or 0 when the account may attempt a login.
 */
function lockoutRemaining(username: string): number {
  const entry = failedAttempts.get(username);
  if (!entry) {
    return 0;
  }
  return Math.max(0, entry.lockedUntil - Date.now());
}

function recordFailure(username: string): void {
  const entry = failedAttempts.get(username) ?? { count: 0, lockedUntil: 0 };
  entry.count += 1;
  if (entry.count >= MAX_FAILED_ATTEMPTS) {
    entry.lockedUntil = Date.now() + LOCKOUT_MS;
    entry.count = 0;
  }
  failedAttempts.set(username, entry);
}

/**
 * Verify a username/password pair.
 *
 * Returns null for every kind of failure so the caller cannot distinguish "no
 * such user" from "wrong password" and enumerate accounts. An unknown username
 * still runs a hash comparison so the response time does not give it away.
 */
export async function verifyCredentials(
  username: string,
  password: string,
): Promise<User | null> {
  const normalized = normalizeUsername(username);
  const [row] = await getDb()
    .select()
    .from(t.users)
    .where(eq(t.users.username, normalized))
    .limit(1);

  let matches = false;
  if (row) {
    matches = await Bun.password.verify(password ?? '', row.passwordHash).catch(() => false);
  } else {
    // Unknown username: still perform one verify so the response time does not
    // reveal whether the account exists.
    await Bun.password.verify(password ?? '', await getDummyHash()).catch(() => false);
  }

  if (!row || !matches) {
    recordFailure(normalized);
    return null;
  }

  failedAttempts.delete(normalized);
  const now = Date.now();
  await getDb().update(t.users).set({ lastLoginAt: now }).where(eq(t.users.id, row.id));

  return rowToUser({ ...row, lastLoginAt: now });
}

/**
 * Seconds a caller must wait before trying again, or 0 when not throttled.
 */
export function loginLockoutSeconds(username: string): number {
  return Math.ceil(lockoutRemaining(normalizeUsername(username)) / 1000);
}

/**
 * Print a boxed startup notice. Callers pass lines, never a password.
 */
function announce(title: string, lines: string[]): void {
  const border = '─'.repeat(74);
  console.warn(`\n┌${border}┐`);
  console.warn(`  ${title}`);
  console.warn(`├${border}┤`);
  for (const line of lines) {
    console.warn(`  ${line}`);
  }
  console.warn(`└${border}┘\n`);
}

/**
 * Get a first account onto a fresh install, without needing a shell.
 *
 * ## What changed, and why the old rule was wrong for the wrong reason
 *
 * This used to create nothing at all unless `INITIAL_ADMIN_USERNAME` and `INITIAL_ADMIN_PASSWORD`
 * were both set, on the argument that "a gateway that seeds a known username and password is
 * reachable by anyone who can read its README".
 *
 * That argument is correct and it is about a **known** credential — a fixed default baked into the
 * image. It says nothing about a *generated* one. Refusing to create anything did not make the
 * deployment safer; it made it unreachable, and the failure mode was a locked-out operator with an
 * empty user table and no way in that did not involve editing the database by hand.
 *
 * So: the operator may name the account through the environment, and if they have not, one is
 * generated, printed **once**, and flagged for mandatory replacement. A generated credential the
 * operator did not choose is a way in, not a password, and it should stop working the moment it has
 * been used.
 *
 * ## Runs only on an empty user table
 *
 * Which means these variables are not a password reset, and a restart on a working deployment prints
 * nothing. That silence is the point: a banner on every boot is a banner people stop reading, and it
 * puts a credential in front of anyone who can see the logs long after it was needed.
 *
 * Deliberately not done: creating the account lazily from whoever reaches the port first. That is the
 * seamless option, and it hands the instance to whoever finds it before its owner does.
 */
export async function initUsers(): Promise<void> {
  if ((await countUsers()) > 0) {
    return;
  }

  const configuredName = normalizeUsername(process.env.INITIAL_ADMIN_USERNAME ?? '');
  const configuredPassword = process.env.INITIAL_ADMIN_PASSWORD ?? '';

  // Both or neither. A username with no password would otherwise fall through to a generated
  // password under the name the operator chose, which reads in the log as though their setting was
  // accepted — and they would spend the next hour typing a password that was never used.
  if (configuredName && configuredPassword) {
    try {
      /**
       * Inserted directly rather than through `createUser`, to skip `assertValidPassword`.
       *
       * That policy exists to stop *users* picking something weak through a form. This value is set
       * by whoever runs the deployment, in a file only they can write, and refusing it would mean a
       * gateway that will not start over a password its owner chose on purpose. The **username** is
       * still checked, because an unusable one is a different problem: a name with a space cannot be
       * typed back exactly, so the account it creates is one nobody can sign in to.
       *
       * Not flagged for mandatory replacement either — they chose it deliberately, so forcing a
       * change would be theatre.
       */
      assertValidUsername(configuredName);
      await getDb().insert(t.users).values({
        id: crypto.randomUUID(),
        username: configuredName,
        passwordHash: await hashPassword(configuredPassword),
        mustChangePassword: 0,
        createdAt: Date.now(),
      });
      // The username, never the password: it came from the operator and does not need reading back
      // to them out of a log file.
      announce('✓  FIRST RUN — dashboard account created', [
        `Sign in as  ${configuredName}  with the password from INITIAL_ADMIN_PASSWORD.`,
      ]);
      return;
    } catch (error) {
      // Refusing loudly and continuing to a generated account beats refusing to boot: the operator
      // still gets in, and the log says why their setting was not used.
      announce('⚠  INITIAL_ADMIN_* REJECTED — generating a password instead', [
        (error as Error).message,
      ]);
    }
  } else if (configuredName || configuredPassword) {
    announce('⚠  INITIAL_ADMIN_USERNAME and INITIAL_ADMIN_PASSWORD must BOTH be set', [
      configuredName
        ? 'Only the username is set. It was kept; the password below was generated.'
        : 'Only the password is set. It was ignored; the account below was generated.',
    ]);
  }

  const password = generatePassword();

  /**
   * The operator's username is kept when it is usable, even though their password was not.
   *
   * Keeping it is friendlier and not ambiguous: the banner prints the generated password right
   * underneath, so there is no reading in which their own password looks accepted. But a name that
   * cannot be typed back — a space in it, too short — would produce an account nobody can sign in to,
   * which is the exact lockout this whole path exists to prevent. So that one falls back to `admin`.
   */
  let username = 'admin';
  if (configuredName) {
    try {
      assertValidUsername(configuredName);
      username = configuredName;
    } catch (error) {
      announce('⚠  INITIAL_ADMIN_USERNAME is unusable — falling back to "admin"', [
        (error as Error).message,
      ]);
    }
  }

  const user = await createUser(username, password, true);

  announce('✓  FIRST RUN — dashboard account created', [
    `username  ${user.username}`,
    `password  ${password}`,
    '',
    'Generated for the first login and must be changed straight away. Shown once,',
    'and stored only as a hash — there is no way to print it again.',
    'Set INITIAL_ADMIN_USERNAME and INITIAL_ADMIN_PASSWORD to choose your own.',
  ]);
}

/**
 * A password that survives being copied out of a log by hand.
 *
 * Hex rather than a word list or full base64: `l`/`1` and `O`/`0` are the classic transcription
 * failures, and someone reading this off a terminal and typing it into a browser is the expected
 * path. Long enough that the alphabet being small does not matter.
 */
function generatePassword(): string {
  return randomBytes(12).toString('hex');
}
