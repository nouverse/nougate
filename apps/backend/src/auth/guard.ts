import { readSession } from "@/auth/session";
import { type User, getUserById } from "@/auth/users";
import { type HostRequest, hostRequest } from "@/core/host";

/**
 * Endpoints a signed-in user may still reach while their password change is
 * outstanding. Everything else stays closed until the default credential is
 * replaced, so a seeded account never grants real access.
 */
const CHANGE_PASSWORD_ALLOWLIST = new Set([
  "/api/auth/me",
  "/api/auth/logout",
  "/api/auth/profile",
]);

/**
 * Paths the dashboard guard protects. The LLM protocol routes are deliberately
 * excluded — they are called by CLI clients that cannot hold a browser session
 * and are guarded separately by gateway API keys.
 */
function isGuardedPath(pathname: string): boolean {
  if (pathname.startsWith("/api/auth/")) {
    return false;
  }
  return (
    pathname.startsWith("/api/") ||
    pathname === "/oauth/start" ||
    pathname === "/oauth-callback"
  );
}

/**
 * Build a JSON error response for a rejected dashboard request.
 */
function denied(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: message, code }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * The person a host vouched for (`core/host.ts`).
 *
 * Not an account in this gateway's table, so there is nothing to look up and no password to force a
 * change of: the host's own sign-in is the one that counts, and it has already been passed. The id
 * is prefixed so it can never equal a real account's — the users page compares ids to stop someone
 * deleting the account they are signed in with.
 */
function hostUser(host: HostRequest): User {
  return {
    id: `host:${host.username}`,
    username: host.username,
    mustChangePassword: false,
    createdAt: 0,
    lastLoginAt: null,
  };
}

/**
 * Resolve the signed-in user for a request, or null.
 *
 * The host is asked first. A request it built and vouches for needs no cookie of ours; one it did
 * not build falls through to the session, as on the gateway's own port.
 *
 * The user is re-read from the database on every request so deleting an account
 * revokes its sessions immediately instead of waiting for the cookie to expire.
 */
export async function getActiveUser(req: Request): Promise<User | null> {
  const host = hostRequest(req);
  if (host) {
    return hostUser(host);
  }

  const session = readSession(req);
  if (!session) {
    return null;
  }
  return await getUserById(session.sub);
}

/**
 * Reject unauthenticated access to the dashboard API.
 * Returns null when the request may proceed.
 */
export async function enforceDashboardAuth(req: Request, url: URL): Promise<Response | null> {
  if (!isGuardedPath(url.pathname)) {
    return null;
  }

  const user = await getActiveUser(req);
  if (!user) {
    return denied(401, "unauthenticated", "Sign in to access the dashboard");
  }

  if (user.mustChangePassword && !CHANGE_PASSWORD_ALLOWLIST.has(url.pathname)) {
    return denied(
      403,
      "password_change_required",
      "Set a new password before using the dashboard",
    );
  }

  return null;
}
