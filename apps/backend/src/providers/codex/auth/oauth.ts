/**
 * Codex OAuth, authorization-code with PKCE (S256).
 *
 * Key differences from Claude's OAuth:
 * - Token refresh is **form-encoded** (`application/x-www-form-urlencoded`), not JSON
 * - The authorize URL includes `extraParams` (id_token_add_organizations, codex_cli_simplified_flow, originator)
 * - `fixedPort: 1455` and `callbackPath: "/auth/callback"` — the redirect URI is `http://localhost:1455/auth/callback`
 * - Refresh includes `scope` param
 * - `maxRefreshAgeMs: 691200000` (8 days) for proactive stale refresh
 * - `refreshLeadMs: 432000000` (5 days) — how early before expiry to refresh
 */

import { createHash, randomBytes } from 'node:crypto';

import { classifyRefreshError, TokenRefreshError } from './refresh-errors';
import { createSingleFlight } from './single-flight';

export const CODEX_OAUTH = {
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  authorizeUrl: 'https://auth.openai.com/oauth/authorize',
  tokenUrl: 'https://auth.openai.com/oauth/token',
  scope: 'openid profile email offline_access',
  codeChallengeMethod: 'S256' as const,
  fixedPort: 1455,
  callbackPath: '/auth/callback',
  extraParams: {
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    originator: 'codex_cli_rs',
  } as Record<string, string>,
  /** 5 days — how early before expiry a token is renewed. */
  refreshLeadMs: 432_000_000,
  /** 8 days — proactive refresh even if the token hasn't expired. */
  maxRefreshAgeMs: 691_200_000,
  refresh: {
    encoding: 'form' as const,
    scope: 'openid profile email offline_access',
  },
} as const;

export interface CodexTokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  scope?: string;
}

function base64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface PendingAuthorization {
  url: string;
  state: string;
  codeVerifier: string;
}

/**
 * Begin a Codex authorization.
 *
 * Returns the verifier alongside the URL — this module stays pure, the caller owns the pending state.
 */
export function beginAuthorization(redirectUri: string): PendingAuthorization {
  const codeVerifier = base64url(randomBytes(32));
  const codeChallenge = base64url(createHash('sha256').update(codeVerifier).digest());
  const state = base64url(randomBytes(32));

  // Match 9router's exact param order and encoding:
  //   response_type, client_id, redirect_uri, scope, code_challenge,
  //   code_challenge_method, ...extraParams, state (LAST)
  // Uses manual encodeURIComponent (encodes spaces as %20, not +).
  const params: Record<string, string> = {
    response_type: 'code',
    client_id: CODEX_OAUTH.clientId,
    redirect_uri: redirectUri,
    scope: CODEX_OAUTH.scope,
    code_challenge: codeChallenge,
    code_challenge_method: CODEX_OAUTH.codeChallengeMethod,
    ...CODEX_OAUTH.extraParams,
    state,
  };

  const queryString = Object.entries(params)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');

  return { url: `${CODEX_OAUTH.authorizeUrl}?${queryString}`, state, codeVerifier };
}

/**
 * Trade the authorization code for tokens.
 */
export async function exchangeCode(
  code: string,
  redirectUri: string,
  codeVerifier: string,
): Promise<CodexTokenResponse> {
  const body = new URLSearchParams({
    code: code.trim(),
    grant_type: 'authorization_code',
    client_id: CODEX_OAUTH.clientId,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });

  console.log(`[codex] token exchange POST ${CODEX_OAUTH.tokenUrl}`);

  const res = await fetch(CODEX_OAUTH.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = (await res.text()).slice(0, 500);
    console.error(`[codex] token exchange ${res.status}: ${text}`);
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }
  return (await res.json()) as CodexTokenResponse;
}

const REFRESH_DEDUP_TTL_MS = 10_000;
const refreshFlight = createSingleFlight<CodexTokenResponse>(REFRESH_DEDUP_TTL_MS);

export function resetRefreshDedup(): void {
  refreshFlight.clear();
}

/**
 * Renew an access token.
 *
 * CRITICAL: Codex uses **form-encoded** refresh, NOT JSON. The `scope` param is included.
 */
export async function refreshTokens(refreshToken: string): Promise<CodexTokenResponse> {
  return refreshFlight.run(refreshToken, async () => {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CODEX_OAUTH.clientId,
      scope: CODEX_OAUTH.refresh.scope,
    });

    const res = await fetch(CODEX_OAUTH.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
    });

    if (!res.ok) throw new TokenRefreshError(classifyRefreshError(await res.text(), res.status));

    const tokens = (await res.json()) as CodexTokenResponse;
    if (!tokens?.access_token) {
      throw new TokenRefreshError({
        status: res.status,
        code: 'no_access_token',
        description: 'the token endpoint returned success but no access_token',
        permanent: false,
      });
    }
    return tokens;
  });
}

/**
 * Whether this token is stale and should be proactively refreshed.
 *
 * Checks both expiry-based lead time AND age-based staleness (maxRefreshAgeMs).
 */
export function isRefreshStale(lastRefreshAt: number | undefined, nowMs = Date.now()): boolean {
  if (!lastRefreshAt) return true;
  return nowMs - lastRefreshAt >= CODEX_OAUTH.maxRefreshAgeMs;
}

export { TokenRefreshError, isPermanentRefreshFailure } from './refresh-errors';
export type { RefreshFailure } from './refresh-errors';
