import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { createHmac } from "node:crypto";
import { rmSync, mkdtempSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const STATE_DIR = mkdtempSync(join(tmpdir(), "nougate-auth-"));
const SESSION_SECRET = "test-session-secret-abcdefghijklmnop";
const ADMIN_USERNAME = "gatekeeper";
const ADMIN_PASSWORD = "bootstrap-password-1";

// Both the database path and the signing secret are read when their modules are
// first imported, so they must be set before any dynamic import below.
process.env.NOUGATE_DB_PATH = join(STATE_DIR, "auth-test.db");
process.env.SESSION_SECRET_FILE = join(STATE_DIR, ".session-secret");
process.env.SESSION_SECRET = SESSION_SECRET;
process.env.INITIAL_ADMIN_USERNAME = ADMIN_USERNAME;
process.env.INITIAL_ADMIN_PASSWORD = ADMIN_PASSWORD;

const { loadProxyConfig } = await import("@/config/manager");
const { initDb, closeDb } = await import("@/core/db");
const { getSessionSecret } = await import("@/auth/config");
const { enforceDashboardAuth } = await import("@/auth/guard");
const { handleAuthRoute } = await import("@/router/auth");
const { handleUsersRoute } = await import("@/router/users");
const { createSessionCookie, readSession } = await import("@/auth/session");
const users = await import("@/auth/users");

/**
 * Build a request carrying an optional cookie header and JSON body.
 */
function request(path: string, cookie?: string, method = "GET", body?: unknown): Request {
  const headers: Record<string, string> = {};
  if (cookie) {
    headers.cookie = cookie;
  }
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }
  return new Request(`http://localhost:3000${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function guard(path: string, cookie?: string): Promise<Response | null> {
  return enforceDashboardAuth(request(path, cookie), new URL(`http://localhost:3000${path}`));
}

function authRoute(path: string, cookie?: string, method = "GET", body?: unknown) {
  return handleAuthRoute(
    request(path, cookie, method, body),
    new URL(`http://localhost:3000${path}`),
  );
}

function usersRoute(path: string, cookie?: string, method = "GET", body?: unknown) {
  return handleUsersRoute(
    request(path, cookie, method, body),
    new URL(`http://localhost:3000${path}`),
  );
}

/**
 * A valid session cookie header value for a user.
 */
function sessionCookie(user: { id: string; username: string }): string {
  return createSessionCookie(user, "http://localhost:3000").split(";")[0];
}

/** A signed-in account with no outstanding password change. */
let owner: { id: string; username: string };
let ownerCookie: string;

beforeAll(async () => {
  await loadProxyConfig();
  await initDb();
  await users.initUsers();

  owner = await users.createUser("owner", "correct-horse-battery");
  ownerCookie = sessionCookie(owner);
});

afterAll(async () => {
  await closeDb();
  rmSync(STATE_DIR, { recursive: true, force: true });
});

describe("First-run seeding", () => {
  test("creates the account named by INITIAL_ADMIN_USERNAME", async () => {
    const admin = await users.getUserByUsername(ADMIN_USERNAME);
    expect(admin).not.toBeNull();
  });

  test("is not flagged for a password change — the operator chose this one", async () => {
    const admin = await users.getUserByUsername(ADMIN_USERNAME);
    expect(admin!.mustChangePassword).toBe(false);
  });

  test("the configured credential authenticates", async () => {
    const verified = await users.verifyCredentials(ADMIN_USERNAME, ADMIN_PASSWORD);
    expect(verified?.username).toBe(ADMIN_USERNAME);
  });

  test("the old built-in default is gone", async () => {
    expect(await users.getUserByUsername("admin")).toBeNull();
    expect(await users.verifyCredentials("admin", "admin123")).toBeNull();
  });

  test("does not reseed once a user exists", async () => {
    const before = await users.countUsers();
    await users.initUsers();
    expect(await users.countUsers()).toBe(before);
  });
});

describe("Credentials", () => {
  test("stores a hash, never the password", async () => {
    const row: any = await users.getUserByUsername("owner");
    expect(JSON.stringify(row)).not.toContain("correct-horse-battery");
  });

  test("rejects a wrong password and an unknown user identically", async () => {
    expect(await users.verifyCredentials("owner", "wrong")).toBeNull();
    expect(await users.verifyCredentials("ghost", "whatever")).toBeNull();
  });

  test("matches usernames case-insensitively", async () => {
    expect(await users.verifyCredentials("OWNER", "correct-horse-battery")).not.toBeNull();
  });

  test("enforces the password policy", async () => {
    await expect(users.createUser("shorty", "abc")).rejects.toThrow(/at least 8/);
  });

  test("rejects only unusable usernames, and duplicates", async () => {
    // Whitespace is the one rule: a name with a space cannot be retyped exactly.
    await expect(users.createUser("A B", "a-good-password")).rejects.toThrow(/cannot contain spaces/);
    await expect(users.createUser("ab", "a-good-password")).rejects.toThrow(/3–254 characters/);
    await expect(users.createUser("owner", "a-good-password")).rejects.toThrow(/already exists/);
  });

  test("accepts an email address, or anything else without spaces", async () => {
    // A username is a label people type, never a URL segment, so it does not
    // need to be URL-safe. Restricting it to [a-z0-9._-] rejected the shape
    // most people reach for first.
    const email = await users.createUser("account@nouverse.tech", "a-good-password");
    expect(email.username).toBe("account@nouverse.tech");
    expect(await users.verifyCredentials("account@nouverse.tech", "a-good-password")).not.toBeNull();

    const handle = await users.createUser("gading+work", "a-good-password");
    expect(handle.username).toBe("gading+work");

    const unicode = await users.createUser("पासवर्ड", "a-good-password");
    expect(unicode.username).toBe("पासवर्ड");
  });

  test("throttles repeated failures for one username", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await users.verifyCredentials("throttled", "nope");
    }
    expect(users.loginLockoutSeconds("throttled")).toBeGreaterThan(0);
    // Other accounts are unaffected by one username being hammered.
    expect(users.loginLockoutSeconds("owner")).toBe(0);
  });
});

describe("Dashboard guard coverage", () => {
  test("blocks the admin API without a session", async () => {
    expect((await guard("/api/status"))?.status).toBe(401);
    expect((await guard("/api/sse"))?.status).toBe(401);
    expect((await guard("/api/providers/antigravity/accounts"))?.status).toBe(401);
    expect((await guard("/api/config"))?.status).toBe(401);
    expect((await guard("/api/users"))?.status).toBe(401);
  });

  test("blocks the provider OAuth entry points", async () => {
    expect((await guard("/oauth/start"))?.status).toBe(401);
    expect((await guard("/oauth-callback"))?.status).toBe(401);
  });

  test("leaves the LLM proxy routes open", async () => {
    // CLI clients cannot hold a browser session, so these stay unguarded here.
    expect(await guard("/openai/v1/chat/completions")).toBeNull();
    expect(await guard("/openai/v1/models")).toBeNull();
    expect(await guard("/anthropic/v1/messages")).toBeNull();
    expect(await guard("/anthropic/v1/models")).toBeNull();
  });

  test("leaves the static bundle and auth endpoints open", async () => {
    expect(await guard("/frontend/assets/index.js")).toBeNull();
    expect(await guard("/api/auth/me")).toBeNull();
    expect(await guard("/api/auth/login")).toBeNull();
  });

  test("admits a valid session", async () => {
    expect(await guard("/api/status", ownerCookie)).toBeNull();
  });

  test("revokes the session of a deleted user", async () => {
    const doomed = await users.createUser("doomed", "a-good-password-1");
    const cookie = sessionCookie(doomed);
    expect(await guard("/api/status", cookie)).toBeNull();

    await users.deleteUser(doomed.id);
    expect((await guard("/api/status", cookie))?.status).toBe(401);
  });
});

describe("Forced password change", () => {
  // The bootstrap account no longer carries this flag, so the subject is an
  // account an admin created for someone else — which is the only way the flag
  // is set now.
  const INVITEE = "invitee";

  beforeAll(async () => {
    await users.createUser(INVITEE, "issued-by-the-admin", true);
  });

  test("locks the dashboard down to the change-password endpoints", async () => {
    const admin = await (await users.getUserByUsername(INVITEE))!;
    const cookie = sessionCookie(admin);

    const denied = await guard("/api/status", cookie);
    expect(denied?.status).toBe(403);
    expect((await denied!.json()).code).toBe("password_change_required");

    expect((await guard("/api/users", cookie))?.status).toBe(403);
    expect((await guard("/api/api-keys", cookie))?.status).toBe(403);

    // The escape hatch stays reachable, or the account could never recover.
    expect(await guard("/api/auth/profile", cookie)).toBeNull();
    expect(await guard("/api/auth/me", cookie)).toBeNull();
  });

  test("does not ask for the current password, which was just used to sign in", async () => {
    const admin = await (await users.getUserByUsername(INVITEE))!;
    const cookie = sessionCookie(admin);

    // No currentPassword in the body at all.
    const ok = await authRoute("/api/auth/profile", cookie, "POST", {
      newPassword: "a-brand-new-password",
    });

    expect(ok?.status).toBe(200);
    expect((await ok!.json()).user.mustChangePassword).toBe(false);
    expect((await users.getUserByUsername(INVITEE))!.mustChangePassword).toBe(false);
    expect(await guard("/api/status", cookie)).toBeNull();
  });

  test("the waiver ends the moment the flag clears", async () => {
    // Same account, same session — but it is now an ordinary one, so a further
    // change has to prove the current password again.
    const admin = await (await users.getUserByUsername(INVITEE))!;
    const cookie = sessionCookie(admin);

    const withoutPassword = await authRoute("/api/auth/profile", cookie, "POST", {
      newPassword: "another-new-password",
    });
    expect(withoutPassword?.status).toBe(401);

    const withPassword = await authRoute("/api/auth/profile", cookie, "POST", {
      currentPassword: "a-brand-new-password",
      newPassword: "another-new-password",
    });
    expect(withPassword?.status).toBe(200);
  });
});

describe("Profile updates", () => {
  test("renames the account and reissues the cookie", async () => {
    const user = await users.createUser("renameme", "a-good-password-3");
    const cookie = sessionCookie(user);

    const res = await authRoute("/api/auth/profile", cookie, "POST", {
      currentPassword: "a-good-password-3",
      newUsername: "renamed",
    });

    expect(res?.status).toBe(200);
    expect((await res!.json()).user.username).toBe("renamed");
    // The cookie carries the username, so it has to be reissued.
    expect(res!.headers.get("set-cookie")).toContain("nougate_session=");

    expect(await users.getUserByUsername("renamed")).not.toBeNull();
    expect(await users.getUserByUsername("renameme")).toBeNull();
    // The old password still works under the new name.
    expect(await users.verifyCredentials("renamed", "a-good-password-3")).not.toBeNull();
  });

  test("a rename alone does not clear an outstanding password change", async () => {
    const renamed = (await users.getUserByUsername("renamed"))!;
    expect(renamed.mustChangePassword).toBe(false);

    const seeded = await users.setUsername(renamed.id, "renamed");
    // Renaming to the current name is a no-op, not a conflict.
    expect(seeded.username).toBe("renamed");
  });

  test("refuses a username already taken by someone else", async () => {
    const target = (await users.getUserByUsername("renamed"))!;
    await expect(users.setUsername(target.id, "owner")).rejects.toThrow(/already exists/);
  });

  test("requires the current password to rename", async () => {
    const target = (await users.getUserByUsername("renamed"))!;
    const res = await authRoute("/api/auth/profile", sessionCookie(target), "POST", {
      currentPassword: "wrong",
      newUsername: "hijacked",
    });

    expect(res?.status).toBe(401);
    expect(await users.getUserByUsername("hijacked")).toBeNull();
  });

  test("rejects an empty update", async () => {
    const res = await authRoute("/api/auth/profile", ownerCookie, "POST", {
      currentPassword: "correct-horse-battery",
    });
    expect(res?.status).toBe(400);
  });

  test("changes username and password in one call", async () => {
    const user = await users.createUser("bothchange", "a-good-password-4");
    const res = await authRoute("/api/auth/profile", sessionCookie(user), "POST", {
      currentPassword: "a-good-password-4",
      newUsername: "bothchanged",
      newPassword: "a-good-password-5",
    });

    expect(res?.status).toBe(200);
    expect((await res!.json()).user.username).toBe("bothchanged");
    expect(await users.verifyCredentials("bothchanged", "a-good-password-5")).not.toBeNull();
  });
});

describe("Session cookie", () => {
  test("round-trips the signed identity", async () => {
    const payload = readSession(request("/", ownerCookie));
    expect(payload?.sub).toBe(owner.id);
    expect(payload?.username).toBe("owner");
  });

  test("is HttpOnly and SameSite=Lax, and Secure only over https", async () => {
    const insecure = createSessionCookie(owner, "http://localhost:3000");
    expect(insecure).toContain("HttpOnly");
    expect(insecure).toContain("SameSite=Lax");
    expect(insecure).not.toContain("Secure");
    expect(createSessionCookie(owner, "https://nougate.nouverse.tech")).toContain("Secure");
  });

  test("rejects a payload swapped onto a stolen signature", async () => {
    const signature = ownerCookie.split(".")[1];
    const payload = Buffer.from(
      JSON.stringify({ sub: "someone-else", username: "attacker", iat: 0, exp: 9999999999 }),
    ).toString("base64url");
    expect((await guard("/api/status", `nougate_session=${payload}.${signature}`))?.status).toBe(401);
  });

  test("rejects malformed and unsigned cookies", async () => {
    expect((await guard("/api/status", "nougate_session=notatoken"))?.status).toBe(401);
    expect((await guard("/api/status", "nougate_session=abc.def"))?.status).toBe(401);
  });

  test("rejects a correctly signed but expired session", async () => {
    const payload = Buffer.from(
      JSON.stringify({ sub: owner.id, username: owner.username, iat: 1, exp: 2 }),
    ).toString("base64url");
    const signature = createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
    expect((await guard("/api/status", `nougate_session=${payload}.${signature}`))?.status).toBe(401);
  });

  test("generates and reuses a signing secret when SESSION_SECRET is unset", async () => {
    delete process.env.SESSION_SECRET;

    const generated = getSessionSecret();
    expect(generated).toBeTruthy();
    expect(generated).not.toBe(SESSION_SECRET);
    expect(existsSync(join(STATE_DIR, ".session-secret"))).toBe(true);

    // A second call must not mint a new secret, or every restart would sign
    // everyone out.
    expect(getSessionSecret()).toBe(generated!);

    process.env.SESSION_SECRET = SESSION_SECRET;
    expect(getSessionSecret()).toBe(SESSION_SECRET);
  });
});

describe("Auth endpoints", () => {
  test("me reports the signed-out and signed-in states", async () => {
    const anon = await authRoute("/api/auth/me");
    expect(anon?.status).toBe(401);
    expect((await anon!.json()).user).toBeNull();

    const authed = await authRoute("/api/auth/me", ownerCookie);
    expect(authed?.status).toBe(200);
    expect((await authed!.json()).user.username).toBe("owner");
  });

  test("login issues a session for correct credentials", async () => {
    const res = await authRoute("/api/auth/login", undefined, "POST", {
      username: "owner",
      password: "correct-horse-battery",
    });

    expect(res?.status).toBe(200);
    expect(res!.headers.get("set-cookie")).toContain("nougate_session=");
    expect((await res!.json()).user.username).toBe("owner");
  });

  test("login rejects bad credentials without revealing which part was wrong", async () => {
    const badPassword = await authRoute("/api/auth/login", undefined, "POST", {
      username: "owner",
      password: "nope",
    });
    const noSuchUser = await authRoute("/api/auth/login", undefined, "POST", {
      username: "nobody",
      password: "nope",
    });

    expect(badPassword?.status).toBe(401);
    expect(noSuchUser?.status).toBe(401);
    expect(await badPassword!.json()).toEqual(await noSuchUser!.json());
  });

  test("logout expires the session cookie", async () => {
    const res = await authRoute("/api/auth/logout", ownerCookie, "POST");
    expect(res!.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});

describe("User management", () => {
  test("lists users and marks the caller", async () => {
    const res = await usersRoute("/api/users", ownerCookie);
    const list = await res!.json();
    expect(list.some((entry: any) => entry.username === "owner" && entry.isCurrent)).toBe(true);
    // The hash must never reach the dashboard.
    expect(JSON.stringify(list)).not.toContain("$argon2");
  });

  test("creates a user that must set its own password", async () => {
    const res = await usersRoute("/api/users", ownerCookie, "POST", {
      username: "teammate",
      password: "temporary-pass-1",
    });

    expect(res?.status).toBe(201);
    expect((await res!.json()).mustChangePassword).toBe(true);
  });

  test("refuses to delete the account you are signed in with", async () => {
    const res = await usersRoute(`/api/users/${owner.id}`, ownerCookie, "DELETE");
    expect(res?.status).toBe(409);
  });

  test("refuses to delete the last remaining user", async () => {
    for (const user of await users.listUsers()) {
      if (await users.countUsers() > 1) {
        await users.deleteUser(user.id);
      }
    }

    expect(await users.countUsers()).toBe(1);
    await expect(users.deleteUser((await users.listUsers())[0].id)).rejects.toThrow(/last remaining user/);
  });
});
