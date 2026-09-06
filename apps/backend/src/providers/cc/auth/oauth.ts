/**
 * Claude's OAuth, authorization-code with PKCE.
 *
 * Endpoints, client id and scopes come from 9router (MIT). A public OAuth client id is not a
 * secret — PKCE exists precisely because a desktop or CLI client cannot keep one — so the value
 * below is an identifier, not a credential.
 *
 * 9router uses `claude.ai/oauth/authorize` with `code=true` and three scopes. The `code=true`
 * param is specific to Claude's OAuth and must be present — without it the authorize page rejects
 * the request.
 *
 * ## How this differs from `antigravity/auth/oauth.ts`, which it otherwise mirrors
 *
 *   - **Real PKCE.** Antigravity sends a fixed `code_challenge` with `method: plain`, which works
 *     against Google's client but is not a challenge at all. Claude requires `S256`, so the verifier
 *     is generated per authorization and must survive until the code comes back — see `pending`.
 *   - **JSON, not form-encoded.** Both the exchange and the refresh take a JSON body. Sending
 *     `application/x-www-form-urlencoded` here returns a 400 that does not say why.
 *   - **No client secret.** There is none to send, and adding an empty one is a 401.
 */

import { createHash, randomBytes } from 'node:crypto';

import { classifyRefreshError, TokenRefreshError } from './refresh-errors';
import { createSingleFlight } from './single-flight';

export const CLAUDE_OAUTH = {
  clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  /** 9router authorize endpoint — `claude.ai`, not `platform.claude.com`. */
  authorizeUrl: 'https://claude.ai/oauth/authorize',
  /** Token exchange — `api.anthropic.com`, NOT `claude.ai`. */
  tokenUrl: 'https://api.anthropic.com/v1/oauth/token',
  /** Three scopes, matching 9router exactly. */
  scopes: [
    'org:create_api_key',
    'user:profile',
    'user:inference',
  ],
  /**
   * How long before expiry a token is renewed.
   *
   * Four hours, from the reference. Generous on purpose: a token that expires mid-request costs a
   * failed turn, and a refresh that runs early costs one HTTP call.
   */
  refreshLeadMs: 4 * 60 * 60 * 1000,
} as const;

export interface ClaudeTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

/** base64url, which is what PKCE requires — `+/=` are not allowed in the challenge. */
function base64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface PendingAuthorization {
  url: string;
  state: string;
  codeVerifier: string;
}

/**
 * Begin an authorization.
 *
 * Returns the verifier alongside the URL rather than storing it here: this module stays pure, and
 * the caller owns how long a half-finished sign-in is allowed to live.
 */
export function beginAuthorization(redirectUri: string): PendingAuthorization {
  const codeVerifier = base64url(randomBytes(32));
  const codeChallenge = base64url(createHash('sha256').update(codeVerifier).digest());
  const state = base64url(randomBytes(32));

  const params = new URLSearchParams({
    code: 'true',
    client_id: CLAUDE_OAUTH.clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: CLAUDE_OAUTH.scopes.join(' '),
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
  });

  return { url: `${CLAUDE_OAUTH.authorizeUrl}?${params.toString()}`, state, codeVerifier };
}

/**
 * Trade the authorization code for tokens.
 *
 * The code Claude hands back can arrive as `<code>#<state>` — the authorize page appends the state
 * to the value a person copies. Splitting it here rather than asking the operator to is the
 * difference between a paste that works and a 400 saying "invalid code".
 */
export async function exchangeCode(
  code: string,
  redirectUri: string,
  codeVerifier: string,
  state: string,
): Promise<ClaudeTokenResponse> {
  const [rawCode, embeddedState] = code.trim().split('#');

  const exchangeBody = {
    code: rawCode,
    state: embeddedState || state,
    grant_type: 'authorization_code',
    client_id: CLAUDE_OAUTH.clientId,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  };

  console.log(`[cc] token exchange POST ${CLAUDE_OAUTH.tokenUrl}`, {
    ...exchangeBody,
    code: exchangeBody.code.slice(0, 8) + '…',
    code_verifier: exchangeBody.code_verifier.slice(0, 8) + '…',
  });

  const res = await fetch(CLAUDE_OAUTH.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(exchangeBody),
  });

  if (!res.ok) {
    const body = (await res.text()).slice(0, 500);
    console.error(`[cc] token exchange ${res.status}: ${body}`);
    throw new Error(`Token exchange failed (${res.status}): ${body}`);
  }
  return (await res.json()) as ClaudeTokenResponse;
}

/**
 * How long a completed refresh answers for the token it consumed.
 *
 * Ten seconds, matching the reference. It is not a cache lifetime — it is the width of the window in
 * which a second caller can still be holding the pre-refresh copy of an account. See
 * `single-flight.ts` for why that window is the dangerous one.
 */
const REFRESH_DEDUP_TTL_MS = 10_000;

/**
 * Keyed by the *old* refresh token rather than by account id.
 *
 * The token is what the server rotates and what it revokes a family over, so it is the thing that
 * must not be presented twice. An account id would also miss the case where two accounts were added
 * from the same sign-in and share a grant.
 */
const refreshFlight = createSingleFlight<ClaudeTokenResponse>(REFRESH_DEDUP_TTL_MS);

/** Test seam: drop the memory of in-flight and recent refreshes. */
export function resetRefreshDedup(): void {
  refreshFlight.clear();
}

/**
 * Renew an access token.
 *
 * `refresh_token` is echoed back only sometimes; when it is absent the existing one stays valid, so
 * the caller keeps it rather than storing `undefined` and losing the ability to refresh again.
 *
 * Two things wrap the bare HTTP call, and both are load-bearing:
 *
 *   - **Single-flight.** Anthropic rotates refresh tokens, so two concurrent renewals of the same
 *     credential make the second one present a spent token — which revokes the whole grant family
 *     rather than merely failing. Concurrent callers share one refresh instead.
 *   - **Classified failures.** A `TokenRefreshError` carries whether the server actually said the
 *     grant is gone. Without it the executor cannot tell a revoked token from a network blip, and
 *     retires the account for either.
 */
export async function refreshTokens(refreshToken: string): Promise<ClaudeTokenResponse> {
  return refreshFlight.run(refreshToken, async () => {
    const res = await fetch(CLAUDE_OAUTH.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CLAUDE_OAUTH.clientId,
      }),
    });

    if (!res.ok) throw new TokenRefreshError(classifyRefreshError(await res.text(), res.status));

    const tokens = (await res.json()) as ClaudeTokenResponse;
    // A 200 carrying no access token is not a success. Letting it through writes an `undefined`
    // credential onto the account, which fails every later request as a 401 and gets diagnosed as an
    // expiry — chasing the wrong thing entirely.
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

export { TokenRefreshError, isPermanentRefreshFailure } from './refresh-errors';
export type { RefreshFailure } from './refresh-errors';
