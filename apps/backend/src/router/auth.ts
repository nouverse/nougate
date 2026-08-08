import { getProxyConfig } from "@/config/manager";
import { isAuthEnabled, isEmailAllowed } from "@/auth/config";
import { buildAuthUrl, exchangeCode, readIdentity } from "@/auth/google";
import { getActiveSession } from "@/auth/guard";
import {
  createLogoutCookie,
  createOAuthState,
  createSessionCookie,
  createStateClearCookie,
  verifyOAuthState,
} from "@/auth/session";

/**
 * The gateway base URL used to build redirect targets.
 */
function getBaseUrl(): string {
  return (getProxyConfig()?.baseUrl || "http://localhost:3000").replace(/\/$/, "");
}

/**
 * Only allow same-origin relative paths as a post-login redirect target so the
 * `next` parameter cannot be used as an open redirect.
 */
function sanitizeNext(next: string | null): string {
  if (!next || !next.startsWith("/") || next.startsWith("//")) {
    return "/frontend/";
  }
  return next;
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
 * Render the standalone page shown when a Google account is not on the allowlist.
 */
function renderForbiddenPage(email: string): Response {
  const safeEmail = email.replace(/[<>&"]/g, "");
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>403 · Access denied</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:#0f1115; color:#e6e8ee; font-family:ui-sans-serif,system-ui,-apple-system,sans-serif; }
  .card { max-width:26rem; padding:2.5rem; text-align:center; }
  .code { font-size:3rem; font-weight:800; letter-spacing:-0.02em; margin:0 0 .5rem; }
  h1 { font-size:1.05rem; margin:0 0 .75rem; font-weight:600; }
  p { font-size:.85rem; line-height:1.6; color:#9aa1b1; margin:0 0 1.5rem; }
  code { background:#1a1d26; padding:.15rem .4rem; border-radius:.3rem; font-size:.8rem; color:#e6e8ee; }
  a { display:inline-block; padding:.6rem 1.2rem; border-radius:.6rem; background:#3b6ef5;
      color:#fff; text-decoration:none; font-size:.8rem; font-weight:600; }
</style>
</head>
<body>
  <div class="card">
    <p class="code">403</p>
    <h1>This account can't access Nougate</h1>
    <p><code>${safeEmail}</code> is not on the allowlist. Ask an administrator to add it to <code>auth.json</code>, then sign in again.</p>
    <a href="/api/auth/login">Try another account</a>
  </div>
</body>
</html>`;

  return new Response(html, {
    status: 403,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * Redirect the browser while clearing the one-shot OAuth state cookie.
 */
function redirectWithCookies(location: string, cookies: string[]): Response {
  const headers = new Headers({ Location: location });
  for (const cookie of cookies) {
    headers.append("Set-Cookie", cookie);
  }
  return new Response(null, { status: 302, headers });
}

/**
 * Start the Google consent flow.
 */
function handleLogin(url: URL): Response {
  const baseUrl = getBaseUrl();
  const next = sanitizeNext(url.searchParams.get("next"));
  const { state, cookie } = createOAuthState(next, baseUrl);

  try {
    return redirectWithCookies(buildAuthUrl(state, baseUrl), [cookie]);
  } catch (error: any) {
    return jsonResponse({ error: error.message || "Login is not configured" }, 500);
  }
}

/**
 * Complete the Google consent flow and issue a session when the email is allowed.
 */
async function handleCallback(req: Request, url: URL): Promise<Response> {
  const baseUrl = getBaseUrl();
  const clearState = createStateClearCookie(baseUrl);

  const googleError = url.searchParams.get("error");
  if (googleError) {
    return jsonResponse({ error: `Google sign-in failed: ${googleError}` }, 400, clearState);
  }

  const { valid, next } = verifyOAuthState(req, url.searchParams.get("state"));
  if (!valid) {
    return jsonResponse(
      { error: "Invalid or expired sign-in request. Please start again." },
      400,
      clearState,
    );
  }

  const code = url.searchParams.get("code");
  if (!code) {
    return jsonResponse({ error: "Missing authorization code" }, 400, clearState);
  }

  try {
    const tokens = await exchangeCode(code, baseUrl);
    if (!tokens.id_token) {
      return jsonResponse({ error: "Google did not return an ID token" }, 502, clearState);
    }

    const identity = readIdentity(tokens.id_token);
    if (!identity.emailVerified) {
      console.warn(`[Auth] Rejected sign-in for unverified email ${identity.email}`);
      return renderForbiddenPage(identity.email);
    }

    if (!isEmailAllowed(identity.email)) {
      console.warn(`[Auth] Rejected sign-in for ${identity.email} (not on allowlist)`);
      return renderForbiddenPage(identity.email);
    }

    console.log(`[Auth] ${identity.email} signed in to the dashboard`);
    return redirectWithCookies(`${baseUrl}${next}`, [
      createSessionCookie(identity.email, baseUrl),
      clearState,
    ]);
  } catch (error: any) {
    console.error("[Auth] Sign-in failed:", error);
    return jsonResponse({ error: error.message || "Sign-in failed" }, 500, clearState);
  }
}

/**
 * Handle the dashboard authentication endpoints.
 */
export async function handleAuthRoute(req: Request, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/auth/")) {
    return null;
  }

  if (url.pathname === "/api/auth/me" && req.method === "GET") {
    if (!isAuthEnabled()) {
      return jsonResponse({ authEnabled: false, email: null });
    }
    const session = getActiveSession(req);
    if (!session) {
      return jsonResponse({ authEnabled: true, email: null }, 401);
    }
    return jsonResponse({ authEnabled: true, email: session.email });
  }

  if (url.pathname === "/api/auth/login" && req.method === "GET") {
    if (!isAuthEnabled()) {
      return redirectWithCookies(`${getBaseUrl()}/frontend/`, []);
    }
    return handleLogin(url);
  }

  if (url.pathname === "/api/auth/callback" && req.method === "GET") {
    if (!isAuthEnabled()) {
      return redirectWithCookies(`${getBaseUrl()}/frontend/`, []);
    }
    return handleCallback(req, url);
  }

  if (url.pathname === "/api/auth/logout" && (req.method === "POST" || req.method === "GET")) {
    return jsonResponse({ ok: true }, 200, createLogoutCookie(getBaseUrl()));
  }

  return new Response("Not Found", { status: 404 });
}
