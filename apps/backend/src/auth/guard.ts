import { isAuthEnabled, isEmailAllowed } from "@/auth/config";
import { readSession } from "@/auth/session";
import { type SessionPayload } from "@/auth/types";

/**
 * Paths that the dashboard guard protects. The LLM protocol routes are
 * deliberately excluded — they are called by CLI clients that cannot hold a
 * browser session and are guarded separately.
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
 * Reject unauthenticated or no-longer-allowed access to the dashboard API.
 * Returns null when the request may proceed.
 */
export function enforceDashboardAuth(req: Request, url: URL): Response | null {
  // Path check first: it is a string comparison, while isAuthEnabled() reads the
  // allowlist from disk. This keeps the LLM proxy hot path free of file I/O.
  if (!isGuardedPath(url.pathname) || !isAuthEnabled()) {
    return null;
  }

  const session = readSession(req);
  if (!session) {
    return denied(401, "unauthenticated", "Sign in to access the dashboard");
  }

  // Re-check on every request so removing an email from the allowlist revokes
  // access immediately instead of waiting for the cookie to expire.
  if (!isEmailAllowed(session.email)) {
    return denied(403, "forbidden", `${session.email} is not allowed to access this dashboard`);
  }

  return null;
}

/**
 * Resolve the current session for the /api/auth/me endpoint.
 */
export function getActiveSession(req: Request): SessionPayload | null {
  const session = readSession(req);
  if (!session || !isEmailAllowed(session.email)) {
    return null;
  }
  return session;
}
