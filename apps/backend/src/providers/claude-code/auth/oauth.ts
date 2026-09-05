/**
 * Claude's OAuth, authorization-code with PKCE.
 *
 * Endpoints, client id and scopes are the public constants from 9router (MIT), which is where the
 * shape of this flow was taken from. A public OAuth client id is not a secret — PKCE exists precisely
 * because a desktop or CLI client cannot keep one — so the value below is an identifier, not a
 * credential.
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

export const CLAUDE_OAUTH = {
  clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  authorizeUrl: 'https://claude.ai/oauth/authorize',
  tokenUrl: 'https://api.anthropic.com/v1/oauth/token',
  scopes: ['org:create_api_key', 'user:profile', 'user:inference'],
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
  const state = base64url(randomBytes(16));

  const params = new URLSearchParams({
    // Not a typo and not documented anywhere — the reference sends it, and the authorize page
    // returns the code in the page rather than only via redirect without it.
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

  const res = await fetch(CLAUDE_OAUTH.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      code: rawCode,
      state: embeddedState || state,
      grant_type: 'authorization_code',
      client_id: CLAUDE_OAUTH.clientId,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
  });

  if (!res.ok) throw new Error(`Token exchange failed: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as ClaudeTokenResponse;
}

/**
 * Renew an access token.
 *
 * `refresh_token` is echoed back only sometimes; when it is absent the existing one stays valid, so
 * the caller keeps it rather than storing `undefined` and losing the ability to refresh again.
 */
export async function refreshTokens(refreshToken: string): Promise<ClaudeTokenResponse> {
  const res = await fetch(CLAUDE_OAUTH.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLAUDE_OAUTH.clientId,
    }),
  });

  if (!res.ok) throw new Error(`Token refresh failed: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as ClaudeTokenResponse;
}
