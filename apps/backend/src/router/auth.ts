import { getProxyConfig } from "@/config/manager";
import { getActiveUser } from "@/auth/guard";
import { createLogoutCookie, createSessionCookie } from "@/auth/session";
import {
  AuthError,
  loginLockoutSeconds,
  setPassword,
  setUsername,
  verifyCredentials,
} from "@/auth/users";

/**
 * The gateway base URL, used to decide whether cookies carry the Secure flag.
 */
function getBaseUrl(): string {
  return (getProxyConfig()?.baseUrl || "http://localhost:3000").replace(/\/$/, "");
}

/**
 * Build a JSON response for the auth endpoints.
 */
function jsonResponse(body: unknown, status = 200, cookie?: string): Response {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (cookie) {
    headers.append("Set-Cookie", cookie);
  }
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * Shape a user for the dashboard. Never includes the password hash.
 */
function publicUser(user: { id: string; username: string; mustChangePassword: boolean }) {
  return {
    id: user.id,
    username: user.username,
    mustChangePassword: user.mustChangePassword,
  };
}

/**
 * Exchange a username and password for a session cookie.
 */
async function handleLogin(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as any;
  const username = String(body?.username ?? "");
  const password = String(body?.password ?? "");

  if (!username || !password) {
    return jsonResponse({ error: "Username and password are required." }, 400);
  }

  const lockedFor = loginLockoutSeconds(username);
  if (lockedFor > 0) {
    return jsonResponse(
      { error: `Too many failed attempts. Try again in ${lockedFor}s.`, code: "rate_limited" },
      429,
    );
  }

  const user = await verifyCredentials(username, password);
  if (!user) {
    // Deliberately identical for unknown users and wrong passwords.
    console.warn(`[Auth] Failed sign-in attempt for "${username}"`);
    return jsonResponse({ error: "Incorrect username or password." }, 401);
  }

  console.log(`[Auth] ${user.username} signed in to the dashboard`);
  return jsonResponse(
    { user: publicUser(user) },
    200,
    createSessionCookie(user, getBaseUrl()),
  );
}

/**
 * Update the signed-in user's own username and/or password.
 *
 * Both fields are optional so one form can serve the first-run setup screen
 * (where the password is mandatory and the username is a nicety) and the
 * account settings page (where either may be changed alone).
 */
async function handleUpdateProfile(req: Request): Promise<Response> {
  const user = getActiveUser(req);
  if (!user) {
    return jsonResponse({ error: "Sign in first." }, 401);
  }

  const body = (await req.json().catch(() => ({}))) as any;
  const currentPassword = String(body?.currentPassword ?? "");
  const newUsername = typeof body?.newUsername === "string" ? body.newUsername.trim() : "";
  const newPassword = typeof body?.newPassword === "string" ? body.newPassword : "";

  if (!newUsername && !newPassword) {
    return jsonResponse({ error: "Nothing to change." }, 400);
  }

  // Normally the current password is required, so a session left open on a
  // shared machine cannot be used to take the account over.
  //
  // The first-run setup is the one exception: the account is still on the
  // credential it was issued, that credential was proven seconds ago to mint
  // this very session, and nothing else in the dashboard is reachable until
  // this completes. Asking for it again would be friction with nothing behind
  // it. The moment the flag clears, the rule above applies.
  if (!user.mustChangePassword) {
    const verified = await verifyCredentials(user.username, currentPassword);
    if (!verified) {
      return jsonResponse({ error: "Current password is incorrect." }, 401);
    }
  }

  let updated = user;

  try {
    if (newUsername) {
      updated = setUsername(user.id, newUsername);
    }
    if (newPassword) {
      await setPassword(user.id, newPassword);
      updated = { ...updated, mustChangePassword: false };
    }
  } catch (error) {
    if (error instanceof AuthError) {
      return jsonResponse({ error: error.message }, error.status);
    }
    throw error;
  }

  const changes = [newUsername && "username", newPassword && "password"].filter(Boolean);
  console.log(`[Auth] ${user.username} updated their ${changes.join(" and ")}`);

  // Re-issue the cookie: it carries the username, and the forced-change flag
  // must stop applying immediately.
  return jsonResponse(
    { user: publicUser(updated) },
    200,
    createSessionCookie(updated, getBaseUrl()),
  );
}

/**
 * Handle the dashboard authentication endpoints.
 */
export async function handleAuthRoute(req: Request, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/auth/")) {
    return null;
  }

  if (url.pathname === "/api/auth/me" && req.method === "GET") {
    const user = getActiveUser(req);
    if (!user) {
      return jsonResponse({ user: null }, 401);
    }
    return jsonResponse({ user: publicUser(user) });
  }

  if (url.pathname === "/api/auth/login" && req.method === "POST") {
    return handleLogin(req);
  }

  if (url.pathname === "/api/auth/profile" && req.method === "POST") {
    return handleUpdateProfile(req);
  }

  if (url.pathname === "/api/auth/logout" && (req.method === "POST" || req.method === "GET")) {
    return jsonResponse({ ok: true }, 200, createLogoutCookie(getBaseUrl()));
  }

  return new Response("Not Found", { status: 404 });
}
