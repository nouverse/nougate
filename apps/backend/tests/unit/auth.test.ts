import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { createHmac } from "node:crypto";
import { writeFileSync, rmSync, mkdtempSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const AUTH_DIR = mkdtempSync(join(tmpdir(), "nougate-auth-"));
const AUTH_FILE = join(AUTH_DIR, "auth.json");
const SESSION_SECRET = "test-session-secret-abcdefghijklmnop";
const ALLOWED = "owner@example.com";

// The auth module resolves its file path and credentials from the environment,
// so these must be in place before it is imported.
process.env.AUTH_FILE = AUTH_FILE;
process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET = "test-secret";
process.env.SESSION_SECRET = SESSION_SECRET;

/**
 * Rewrite the allowlist. The module reads it live, so no reload call is needed.
 */
function setAllowlist(emails: string[], enabled = true): void {
  writeFileSync(
    AUTH_FILE,
    JSON.stringify({ enabled, allowedEmails: emails, sessionTtlHours: 168 }, null, 2),
  );
}

const { loadProxyConfig } = await import("@/config/manager");
const { loadAuthConfig, isAuthEnabled, isEmailAllowed, getSessionSecret } =
  await import("@/auth/config");
const { enforceDashboardAuth } = await import("@/auth/guard");
const { handleAuthRoute } = await import("@/router/auth");
const {
  createSessionCookie,
  readSession,
  verifyOAuthState,
} = await import("@/auth/session");

/**
 * Build a request carrying an optional cookie header.
 */
function request(path: string, cookie?: string, method = "GET"): Request {
  return new Request(`http://localhost:3000${path}`, {
    method,
    headers: cookie ? { cookie } : undefined,
  });
}

/**
 * Run the dashboard guard for a path, returning the rejection or null.
 */
function guard(path: string, cookie?: string): Response | null {
  return enforceDashboardAuth(request(path, cookie), new URL(`http://localhost:3000${path}`));
}

/**
 * Route through the auth endpoints.
 */
function authRoute(path: string, cookie?: string, method = "GET"): Promise<Response | null> {
  return handleAuthRoute(request(path, cookie, method), new URL(`http://localhost:3000${path}`));
}

/**
 * A valid session cookie header value for an email.
 */
function sessionCookie(email: string): string {
  return createSessionCookie(email, "http://localhost:3000").split(";")[0];
}

beforeAll(async () => {
  await loadProxyConfig();
  setAllowlist([ALLOWED]);
  loadAuthConfig();
});

afterAll(() => {
  rmSync(AUTH_DIR, { recursive: true, force: true });
});

describe("Auth config", () => {
  test("is enabled once the file and credentials are present", () => {
    setAllowlist([ALLOWED]);
    expect(isAuthEnabled()).toBe(true);
  });

  test("matches emails case-insensitively and ignores surrounding space", () => {
    setAllowlist(["  Owner@Example.COM  "]);
    expect(isEmailAllowed("owner@example.com")).toBe(true);
    expect(isEmailAllowed("OWNER@EXAMPLE.COM")).toBe(true);
    expect(isEmailAllowed("attacker@evil.com")).toBe(false);
  });

  test("stays off when disabled in the file", () => {
    setAllowlist([ALLOWED], false);
    expect(isAuthEnabled()).toBe(false);
    expect(guard("/api/status")).toBeNull();
    setAllowlist([ALLOWED]);
  });

  test("stays ON with an empty allowlist, admitting nobody", () => {
    setAllowlist([]);
    expect(isAuthEnabled()).toBe(true);
    expect(guard("/api/status")?.status).toBe(401);
    expect(guard("/api/status", sessionCookie(ALLOWED))?.status).toBe(403);
    setAllowlist([ALLOWED]);
  });

  test("stays ON when the Google credentials go missing", () => {
    // A typo in the environment must never silently reopen the dashboard.
    const clientId = process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_ID;

    expect(isAuthEnabled()).toBe(true);
    expect(guard("/api/status")?.status).toBe(401);

    process.env.GOOGLE_CLIENT_ID = clientId;
  });

  test("generates and reuses a signing secret when SESSION_SECRET is unset", () => {
    delete process.env.SESSION_SECRET;

    const generated = getSessionSecret();
    expect(generated).toBeTruthy();
    expect(generated).not.toBe(SESSION_SECRET);
    expect(existsSync(join(AUTH_DIR, ".session-secret"))).toBe(true);

    // A second call must not mint a new secret, or every restart would sign
    // everyone out.
    expect(getSessionSecret()).toBe(generated!);

    // The env var still takes precedence when present.
    process.env.SESSION_SECRET = SESSION_SECRET;
    expect(getSessionSecret()).toBe(SESSION_SECRET);
  });

  test("picks up allowlist edits without a restart", () => {
    setAllowlist([ALLOWED]);
    expect(isEmailAllowed("late@example.com")).toBe(false);

    setAllowlist([ALLOWED, "late@example.com"]);
    expect(isEmailAllowed("late@example.com")).toBe(true);

    setAllowlist([ALLOWED]);
  });

  test("fails closed on a malformed allowlist", () => {
    writeFileSync(AUTH_FILE, "{ this is not json");
    // A corrupt file must deny everyone, never admit everyone.
    expect(isAuthEnabled()).toBe(true);
    expect(isEmailAllowed(ALLOWED)).toBe(false);
    expect(guard("/api/status")?.status).toBe(401);
    expect(guard("/api/status", sessionCookie(ALLOWED))?.status).toBe(403);
    setAllowlist([ALLOWED]);
  });
});

describe("Dashboard guard coverage", () => {
  test("blocks the admin API without a session", () => {
    expect(guard("/api/status")?.status).toBe(401);
    expect(guard("/api/sse")?.status).toBe(401);
    expect(guard("/api/providers/antigravity/accounts")?.status).toBe(401);
    expect(guard("/api/config")?.status).toBe(401);
  });

  test("blocks the provider OAuth entry points", () => {
    expect(guard("/oauth/start")?.status).toBe(401);
    expect(guard("/oauth-callback")?.status).toBe(401);
  });

  test("leaves the LLM proxy routes open", () => {
    // CLI clients cannot hold a browser session, so these stay unguarded here.
    expect(guard("/openai/v1/chat/completions")).toBeNull();
    expect(guard("/openai/v1/models")).toBeNull();
    expect(guard("/anthropic/v1/messages")).toBeNull();
    expect(guard("/anthropic/v1/models")).toBeNull();
  });

  test("leaves the static bundle and auth endpoints open", () => {
    expect(guard("/frontend/assets/index.js")).toBeNull();
    expect(guard("/api/auth/me")).toBeNull();
    expect(guard("/api/auth/login")).toBeNull();
  });

  test("admits a valid session", () => {
    expect(guard("/api/status", sessionCookie(ALLOWED))).toBeNull();
  });
});

describe("Session cookie", () => {
  test("round-trips the signed identity", () => {
    const cookie = sessionCookie(ALLOWED);
    expect(readSession(request("/", cookie))?.email).toBe(ALLOWED);
  });

  test("is HttpOnly and SameSite=Lax, and Secure only over https", () => {
    const insecure = createSessionCookie(ALLOWED, "http://localhost:3000");
    expect(insecure).toContain("HttpOnly");
    expect(insecure).toContain("SameSite=Lax");
    expect(insecure).not.toContain("Secure");
    expect(createSessionCookie(ALLOWED, "https://nougate.nouverse.tech")).toContain("Secure");
  });

  test("rejects a payload swapped onto a stolen signature", () => {
    const signature = sessionCookie(ALLOWED).split(".")[1];
    const payload = Buffer.from(
      JSON.stringify({ email: "attacker@evil.com", iat: 0, exp: 9999999999 }),
    ).toString("base64url");
    expect(guard("/api/status", `nougate_session=${payload}.${signature}`)?.status).toBe(401);
  });

  test("rejects malformed and unsigned cookies", () => {
    expect(guard("/api/status", "nougate_session=notatoken")?.status).toBe(401);
    expect(guard("/api/status", "nougate_session=abc.def")?.status).toBe(401);
  });

  test("rejects a correctly signed but expired session", () => {
    const payload = Buffer.from(
      JSON.stringify({ email: ALLOWED, iat: 1, exp: 2 }),
    ).toString("base64url");
    const signature = createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
    expect(guard("/api/status", `nougate_session=${payload}.${signature}`)?.status).toBe(401);
  });

  test("revokes an existing session when the email leaves the allowlist", async () => {
    const cookie = sessionCookie(ALLOWED);
    expect(guard("/api/status", cookie)).toBeNull();

    setAllowlist(["someone.else@example.com"]);
    const denied = guard("/api/status", cookie);
    expect(denied?.status).toBe(403);
    expect((await denied!.json()).code).toBe("forbidden");

    setAllowlist([ALLOWED]);
  });
});

describe("Auth endpoints", () => {
  test("me reports the signed-out and signed-in states", async () => {
    const anon = await authRoute("/api/auth/me");
    expect(anon?.status).toBe(401);
    expect((await anon!.json()).email).toBeNull();

    const authed = await authRoute("/api/auth/me", sessionCookie(ALLOWED));
    expect(authed?.status).toBe(200);
    expect((await authed!.json()).email).toBe(ALLOWED);
  });

  test("login redirects to Google with the registered callback", async () => {
    const res = await authRoute("/api/auth/login?next=/frontend/config");
    const location = res!.headers.get("location") || "";
    expect(location).toStartWith("https://accounts.google.com/o/oauth2/v2/auth");

    const params = new URL(location).searchParams;
    expect(params.get("scope")).toBe("openid email profile");
    expect(params.get("redirect_uri")).toBe("http://localhost:3000/api/auth/callback");
    expect(res!.headers.get("set-cookie")).toContain("nougate_oauth_state");
  });

  test("rewrites a protocol-relative next into the dashboard path", async () => {
    const res = await authRoute("/api/auth/login?next=//evil.com/steal");
    const state = new URL(res!.headers.get("location")!).searchParams.get("state")!;
    const decoded = JSON.parse(Buffer.from(state, "base64url").toString("utf8"));
    expect(decoded.next).toBe("/frontend/");
  });

  test("validates the OAuth state against its cookie", async () => {
    const res = await authRoute("/api/auth/login");
    const state = new URL(res!.headers.get("location")!).searchParams.get("state")!;
    const stateCookie = res!.headers.get("set-cookie")!.split(";")[0];

    expect(verifyOAuthState(request("/", stateCookie), state).valid).toBe(true);
    expect(verifyOAuthState(request("/"), state).valid).toBe(false);
    expect(verifyOAuthState(request("/", "nougate_oauth_state=other"), state).valid).toBe(false);
  });

  test("rejects a callback that carries no state", async () => {
    const res = await authRoute("/api/auth/callback?code=abc");
    expect(res?.status).toBe(400);
  });

  test("logout expires the session cookie", async () => {
    const res = await authRoute("/api/auth/logout", sessionCookie(ALLOWED), "POST");
    expect(res!.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});
