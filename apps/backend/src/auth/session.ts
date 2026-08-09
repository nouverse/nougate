import { createHmac, timingSafeEqual } from "node:crypto";
import { getSessionSecret, getSessionTtlHours } from "@/auth/config";
import { type SessionPayload } from "@/auth/types";

export const SESSION_COOKIE = "nougate_session";

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
 * SameSite=Lax blocks the cookie on cross-site POSTs, which is what protects
 * the state-changing admin endpoints from CSRF.
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
 * Issue a signed, stateless session cookie for an authenticated user.
 */
export function createSessionCookie(
  user: { id: string; username: string },
  baseUrl: string,
): string {
  const secret = getSessionSecret();
  if (!secret) {
    throw new Error("SESSION_SECRET is not configured");
  }

  const ttlSeconds = getSessionTtlHours() * 3600;
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    sub: user.id,
    username: user.username,
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
    if (!payload.sub || !payload.username || typeof payload.exp !== "number") {
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
