import { readSession } from "@/auth/session";
import { type User, getUserById } from "@/auth/users";

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
 * Resolve the signed-in user for a request, or null.
 *
 * The user is re-read from the database on every request so deleting an account
 * revokes its sessions immediately instead of waiting for the cookie to expire.
 */
export async function getActiveUser(req: Request): Promise<User | null> {
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
