/**
 * Renewing a Kiro access token. Three paths, chosen by how the account signed in:
 *
 *   - `builder-id` / `idc`  → AWS SSO OIDC `CreateToken` with the registered client's secret.
 *   - `social`              → Kiro's desktop auth service, which takes the refresh token alone.
 *   - `external_idp`        → the Microsoft token endpoint the account was imported with.
 *
 * API keys do not renew; they are valid until revoked.
 */

import { MICROSOFT_TOKEN_HOSTS, KIRO_SOCIAL_REFRESH_URL, oidcEndpoints } from '../upstream/endpoints';
import type { KiroAccount, KiroTokenSet } from './types';

/** The fields renewal reads — a stored account, or one still being validated at import. */
export type RefreshableCredential = Pick<
  KiroAccount,
  'authMethod' | 'refreshToken' | 'clientId' | 'clientSecret' | 'region' | 'tokenEndpoint' | 'scope'
>;

const REFRESH_TIMEOUT_MS = 30_000;

/** Renew this long before expiry, so a request is never signed with a token about to die. */
export const KIRO_REFRESH_LEAD_MS = 5 * 60 * 1000;

export class KiroRefreshError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    /** The credential is finished: only a new sign-in helps. */
    readonly permanent: boolean,
  ) {
    super(message);
    this.name = 'KiroRefreshError';
  }
}

/** Whether the account can renew itself at all. */
export function canRefresh(account: RefreshableCredential): boolean {
  if (account.authMethod === 'api_key' || !account.refreshToken) return false;
  if (account.authMethod === 'builder-id' || account.authMethod === 'idc') {
    return Boolean(account.clientId && account.clientSecret);
  }
  if (account.authMethod === 'external_idp') return Boolean(account.clientId && account.tokenEndpoint && account.scope);
  return true;
}

export function needsRefresh(account: RefreshableCredential & Pick<KiroAccount, 'expiresAt'>, now = Date.now()): boolean {
  return canRefresh(account) && account.expiresAt !== undefined && account.expiresAt - now < KIRO_REFRESH_LEAD_MS;
}

/**
 * Only a refusal of the credential itself is permanent. A 5xx, a 429 or a network failure says
 * nothing about the token, and invalidating on one would take a healthy account out until someone
 * noticed.
 */
function classify(status: number, body: string): KiroRefreshError {
  const permanent = status === 400 || status === 401 || status === 403;
  // The body is an upstream error description, not a token; it is still cut short for the log.
  return new KiroRefreshError(`token refresh failed (${status}): ${body.slice(0, 300)}`, status, permanent);
}

async function post(url: string, init: { headers: Record<string, string>; body: string }): Promise<any> {
  let response: Response;
  try {
    response = await fetch(url, { method: 'POST', ...init, signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS) });
  } catch (error) {
    throw new KiroRefreshError(`token refresh did not reach the server: ${(error as Error).message}`, undefined, false);
  }
  if (!response.ok) throw classify(response.status, await response.text().catch(() => ''));
  return response.json();
}

export function validateMicrosoftTokenEndpoint(raw: string | undefined): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) throw new Error('token_endpoint is required');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('token_endpoint must be a valid URL');
  }
  if (parsed.protocol !== 'https:') throw new Error('token_endpoint must use https');
  if (!MICROSOFT_TOKEN_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error('token_endpoint must be a Microsoft login endpoint');
  }
  return parsed.toString();
}

async function refreshOidc(account: RefreshableCredential): Promise<KiroTokenSet> {
  const data = await post(oidcEndpoints(account.region).token, {
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      clientId: account.clientId,
      clientSecret: account.clientSecret,
      refreshToken: account.refreshToken,
      grantType: 'refresh_token',
    }),
  });
  return {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    expiresIn: data.expiresIn,
    profileArn: data.profileArn,
  };
}

/** Renew a desktop (Google/GitHub) refresh token. Exported for token import, which validates by renewing. */
export async function refreshSocialToken(refreshToken: string): Promise<KiroTokenSet> {
  const data = await post(KIRO_SOCIAL_REFRESH_URL, {
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'kiro-cli/1.0.0' },
    body: JSON.stringify({ refreshToken }),
  });
  return {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    expiresIn: data.expiresIn ?? 3600,
    profileArn: data.profileArn,
  };
}

async function refreshExternalIdp(account: RefreshableCredential): Promise<KiroTokenSet> {
  const endpoint = validateMicrosoftTokenEndpoint(account.tokenEndpoint);
  const data = await post(endpoint, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: account.clientId!,
      refresh_token: account.refreshToken!,
      scope: account.scope!,
    }).toString(),
  });
  return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresIn: data.expires_in };
}

/**
 * One renewal per refresh token at a time.
 *
 * Concurrent requests that all find the token stale must share the one call: OIDC rotates the
 * refresh token on use, so a second call with the old one would be refused and the account wrongly
 * invalidated.
 */
const inFlight = new Map<string, Promise<KiroTokenSet>>();

export function refreshKiroTokens(account: RefreshableCredential): Promise<KiroTokenSet> {
  if (!canRefresh(account)) {
    return Promise.reject(new KiroRefreshError('this account cannot renew its token — sign in again', undefined, true));
  }
  const key = account.refreshToken!;
  const running = inFlight.get(key);
  if (running) return running;

  const promise = (async () => {
    const tokens =
      account.authMethod === 'external_idp'
        ? await refreshExternalIdp(account)
        : account.authMethod === 'social'
          ? await refreshSocialToken(account.refreshToken!)
          : await refreshOidc(account);
    if (!tokens.accessToken) {
      throw new KiroRefreshError('token refresh answered without an access token', 200, false);
    }
    return tokens;
  })().finally(() => inFlight.delete(key));

  inFlight.set(key, promise);
  return promise;
}
