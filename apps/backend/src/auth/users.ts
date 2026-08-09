import { dbAll, dbGet, dbRun } from '@/core/db';

export interface User {
  id: string;
  username: string;
  mustChangePassword: boolean;
  createdAt: number;
  lastLoginAt: number | null;
}

interface UserRow extends Omit<User, 'mustChangePassword'> {
  password_hash: string;
  must_change_password: number;
  created_at: number;
  last_login_at: number | null;
}

export const DEFAULT_USERNAME = 'admin';
export const DEFAULT_PASSWORD = 'admin123';

const MIN_PASSWORD_LENGTH = 8;
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,31}$/;

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
    mustChangePassword: row.must_change_password === 1,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at ?? null,
  };
}

export function normalizeUsername(username: string): string {
  return (username ?? '').trim().toLowerCase();
}

/**
 * Reject usernames that would be ambiguous or awkward to address in URLs.
 */
function assertValidUsername(username: string): void {
  if (!USERNAME_PATTERN.test(username)) {
    throw new AuthError(
      'Username must be 3–32 characters: lowercase letters, digits, dot, dash or underscore, starting with a letter or digit.',
    );
  }
}

/**
 * Enforce the password policy.
 *
 * The seeded default is explicitly rejected so "change your password" cannot be
 * satisfied by re-entering the credential everyone already knows.
 */
function assertValidPassword(password: string): void {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new AuthError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (password === DEFAULT_PASSWORD) {
    throw new AuthError('Choose a password other than the default one.');
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

export function listUsers(): User[] {
  return dbAll<UserRow>('SELECT * FROM users ORDER BY created_at ASC').map(rowToUser);
}

export function countUsers(): number {
  const row = dbGet<{ total: number }>('SELECT COUNT(*) AS total FROM users');
  return row?.total ?? 0;
}

export function getUserById(id: string): User | null {
  const row = dbGet<UserRow>('SELECT * FROM users WHERE id = $id', { $id: id });
  return row ? rowToUser(row) : null;
}

export function getUserByUsername(username: string): User | null {
  const row = dbGet<UserRow>('SELECT * FROM users WHERE username = $username', {
    $username: normalizeUsername(username),
  });
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

  if (getUserByUsername(normalized)) {
    throw new AuthError(`User "${normalized}" already exists.`, 409);
  }

  const user: User = {
    id: crypto.randomUUID(),
    username: normalized,
    mustChangePassword,
    createdAt: Date.now(),
    lastLoginAt: null,
  };

  dbRun(
    `INSERT INTO users (id, username, password_hash, must_change_password, created_at)
     VALUES ($id, $username, $hash, $mustChange, $createdAt)`,
    {
      $id: user.id,
      $username: user.username,
      $hash: await hashPassword(password),
      $mustChange: mustChangePassword ? 1 : 0,
      $createdAt: user.createdAt,
    },
  );

  return user;
}

/**
 * Rename a user.
 *
 * Returns the updated record. Renaming to the current name is a no-op rather
 * than a conflict, so a settings form can submit unchanged fields safely.
 */
export function setUsername(userId: string, newUsername: string): User {
  const normalized = normalizeUsername(newUsername);
  assertValidUsername(normalized);

  const current = getUserById(userId);
  if (!current) {
    throw new AuthError('User not found.', 404);
  }

  if (current.username === normalized) {
    return current;
  }

  const taken = getUserByUsername(normalized);
  if (taken && taken.id !== userId) {
    throw new AuthError(`User "${normalized}" already exists.`, 409);
  }

  dbRun('UPDATE users SET username = $username WHERE id = $id', {
    $id: userId,
    $username: normalized,
  });

  return { ...current, username: normalized };
}

/**
 * Replace a user's password and clear any forced-change flag.
 */
export async function setPassword(userId: string, newPassword: string): Promise<void> {
  assertValidPassword(newPassword);

  const result = dbRun(
    `UPDATE users SET password_hash = $hash, must_change_password = 0 WHERE id = $id`,
    { $id: userId, $hash: await hashPassword(newPassword) },
  );

  if (result.changes === 0) {
    throw new AuthError('User not found.', 404);
  }
}

/**
 * Delete a user, refusing to remove the last one — that would lock everybody out
 * of a dashboard whose only recovery path is editing the database by hand.
 */
export function deleteUser(userId: string): void {
  if (countUsers() <= 1) {
    throw new AuthError('Cannot delete the last remaining user.', 409);
  }

  const result = dbRun('DELETE FROM users WHERE id = $id', { $id: userId });
  if (result.changes === 0) {
    throw new AuthError('User not found.', 404);
  }
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
  const row = dbGet<UserRow>('SELECT * FROM users WHERE username = $username', {
    $username: normalized,
  });

  let matches = false;
  if (row) {
    matches = await Bun.password.verify(password ?? '', row.password_hash).catch(() => false);
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
  dbRun('UPDATE users SET last_login_at = $now WHERE id = $id', {
    $now: Date.now(),
    $id: row.id,
  });

  return rowToUser({ ...row, last_login_at: Date.now() });
}

/**
 * Seconds a caller must wait before trying again, or 0 when not throttled.
 */
export function loginLockoutSeconds(username: string): number {
  return Math.ceil(lockoutRemaining(normalizeUsername(username)) / 1000);
}

/**
 * Create the bootstrap account when the database has no users yet.
 *
 * The seeded credential is flagged for mandatory replacement, so it only ever
 * grants access to the change-password screen.
 */
export async function initUsers(): Promise<void> {
  if (countUsers() > 0) {
    return;
  }

  dbRun(
    `INSERT INTO users (id, username, password_hash, must_change_password, created_at)
     VALUES ($id, $username, $hash, 1, $createdAt)`,
    {
      $id: crypto.randomUUID(),
      $username: DEFAULT_USERNAME,
      $hash: await hashPassword(DEFAULT_PASSWORD),
      $createdAt: Date.now(),
    },
  );

  const border = '─'.repeat(74);
  console.warn(`\n┌${border}┐`);
  console.warn('  ⚠  FIRST RUN — default dashboard account created');
  console.warn(`├${border}┤`);
  console.warn(`  Sign in with  ${DEFAULT_USERNAME} / ${DEFAULT_PASSWORD}`);
  console.warn('  You must set a new password before anything else unlocks.');
  console.warn(`└${border}┘\n`);
}
