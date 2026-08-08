import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getAuthConfig, getSessionSecret } from "@/auth/config";
import { type SessionPayload } from "@/auth/types";

export const SESSION_COOKIE = "nougate_session";
export const STATE_COOKIE = "nougate_oauth_state";

/**
 * Encode bytes or text as base64url without padding.
 */
function toBase64Url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * Sign a payload string with the session secret.
 */
function sign(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

/**
 * Compare two signatures without leaking timing information.
 */
function signaturesMatch(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) {
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}

/**
 * Parse the Cookie header into a plain lookup object.
 */
export function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.get("cookie");
  if (!header) {
    return {};
  }

  const cookies: Record<string, string> = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) {
      continue;
    }
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) {
      cookies[name] = decodeURIComponent(value);
    }
  }
  return cookies;
}

/**
 * Build a Set-Cookie header value with the shared hardening flags.
 *
 * SameSite=Lax keeps the cookie on the top-level redirect back from Google
 * while blocking it on cross-site POSTs, which is what protects the
 * state-changing admin endpoints from CSRF.
 */
function buildCookie(
  name: string,
  value: string,
  maxAgeSeconds: number,
  secure: boolean,
): string {
  const attributes = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) {
    attributes.push("Secure");
  }
  return attributes.join("; ");
}

/**
 * Whether cookies should carry the Secure flag, based on the gateway base URL.
 */
function useSecureCookies(baseUrl: string): boolean {
  return baseUrl.startsWith("https://");
}

/**
 * Issue a signed, stateless session cookie for an authenticated email.
 */
export function createSessionCookie(email: string, baseUrl: string): string {
  const secret = getSessionSecret();
  if (!secret) {
    throw new Error("SESSION_SECRET is not configured");
  }

  const ttlSeconds = getAuthConfig().sessionTtlHours * 3600;
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    email,
    iat: issuedAt,
    exp: issuedAt + ttlSeconds,
  };

  const encoded = toBase64Url(JSON.stringify(payload));
  const token = `${encoded}.${sign(encoded, secret)}`;
  return buildCookie(SESSION_COOKIE, token, ttlSeconds, useSecureCookies(baseUrl));
}

/**
 * Expire the session cookie.
 */
export function createLogoutCookie(baseUrl: string): string {
  return buildCookie(SESSION_COOKIE, "", 0, useSecureCookies(baseUrl));
}

/**
 * Verify the session cookie and return its payload when it is valid and unexpired.
 */
export function readSession(req: Request): SessionPayload | null {
  const secret = getSessionSecret();
  if (!secret) {
    return null;
  }

  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) {
    return null;
  }

  const separator = token.lastIndexOf(".");
  if (separator === -1) {
    return null;
  }

  const encoded = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  if (!signaturesMatch(signature, sign(encoded, secret))) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as SessionPayload;
    if (!payload.email || typeof payload.exp !== "number") {
      return null;
    }
    if (payload.exp <= Math.floor(Date.now() / 1000)) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

/**
 * Create a single-use OAuth state value plus the cookie that carries its copy.
 */
export function createOAuthState(
  next: string,
  baseUrl: string,
): { state: string; cookie: string } {
  const nonce = randomBytes(16).toString("base64url");
  const state = toBase64Url(JSON.stringify({ nonce, next }));
  return {
    state,
    cookie: buildCookie(STATE_COOKIE, nonce, 600, useSecureCookies(baseUrl)),
  };
}

/**
 * Validate the state returned by Google against the nonce cookie.
 */
export function verifyOAuthState(
  req: Request,
  state: string | null,
): { valid: boolean; next: string } {
  const expected = parseCookies(req)[STATE_COOKIE];
  if (!state || !expected) {
    return { valid: false, next: "/frontend/" };
  }

  try {
    const decoded = JSON.parse(Buffer.from(state, "base64url").toString("utf8"));
    if (typeof decoded.nonce !== "string" || !signaturesMatch(decoded.nonce, expected)) {
      return { valid: false, next: "/frontend/" };
    }
    const next = typeof decoded.next === "string" ? decoded.next : "/frontend/";
    return { valid: true, next };
  } catch {
    return { valid: false, next: "/frontend/" };
  }
}

/**
 * Expire the short-lived OAuth state cookie.
 */
export function createStateClearCookie(baseUrl: string): string {
  return buildCookie(STATE_COOKIE, "", 0, useSecureCookies(baseUrl));
}
