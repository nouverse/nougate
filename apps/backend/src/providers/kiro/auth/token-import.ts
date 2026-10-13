/**
 * Adding a Kiro account by pasting a credential instead of signing in through the dashboard.
 *
 * One text field takes three things, told apart by shape rather than by a dropdown the operator
 * could set wrong:
 *
 *   - **JSON** — a token set exported from another tool. Either an enterprise (`external_idp`) set
 *     with a Microsoft `token_endpoint`, or an AWS SSO cache entry carrying `clientId` +
 *     `clientSecret` + `refreshToken` (Builder ID / IAM Identity Center).
 *   - **`aor…`** — a Kiro desktop refresh token from a Google or GitHub sign-in.
 *   - **anything else** — a Kiro API key.
 *
 * Every path proves the credential works before it is stored: a refresh for tokens, a model-list
 * call for keys. Nothing here reads the host filesystem; the operator brings the credential.
 */

import { KIRO_DEFAULT_REGION, assertValidRegion, regionFromProfileArn } from '../upstream/endpoints';
import type { NewKiroAccount } from './manager';
import { fetchModelCatalog } from './profile';
import { refreshKiroTokens, refreshSocialToken, validateMicrosoftTokenEndpoint } from './refresh';

/** Desktop refresh tokens all begin this way; it is how they are told apart from API keys. */
const SOCIAL_REFRESH_PREFIX = 'aor';

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Decode a JWT payload without verifying it — only for an email to label the account with. */
export function decodeJwtPayload(token: string): Record<string, any> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const b64 = parts[1]!.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(b64 + '='.repeat((4 - (b64.length % 4)) % 4), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function emailFromToken(token: string): string | undefined {
  const payload = decodeJwtPayload(token);
  const email = payload?.email || payload?.preferred_username || payload?.upn;
  return typeof email === 'string' ? email : undefined;
}

function expiresAtFrom(input: Record<string, any>, accessToken: string): number {
  const explicit = input.expired || input.expires_at || input.expiresAt;
  if (explicit) {
    const ms = new Date(explicit).getTime();
    if (Number.isFinite(ms)) return ms;
  }
  const expiresIn = Number(input.expires_in || input.expiresIn);
  if (Number.isFinite(expiresIn) && expiresIn > 0) return Date.now() + expiresIn * 1000;
  const exp = decodeJwtPayload(accessToken)?.exp;
  if (typeof exp === 'number') return exp * 1000;
  return Date.now() + 3600 * 1000;
}

function normalizeScope(scopes: unknown): string {
  if (Array.isArray(scopes)) return scopes.map(str).filter(Boolean).join(' ');
  return str(scopes);
}

/** An enterprise (Microsoft Entra) token set, as CLIProxyAPI and similar tools export it. */
export function parseExternalIdpAuth(input: Record<string, any>): NewKiroAccount {
  const method = str(input.auth_method || input.authMethod);
  if (method && method !== 'external_idp') throw new Error('Only external_idp token sets are accepted here');

  const accessToken = str(input.access_token || input.accessToken);
  const refreshToken = str(input.refresh_token || input.refreshToken);
  const clientId = str(input.client_id || input.clientId);
  const tokenEndpoint = validateMicrosoftTokenEndpoint(input.token_endpoint || input.tokenEndpoint);
  const profileArn = str(input.profile_arn || input.profileArn);
  const scope = normalizeScope(input.scopes || input.scope);
  const region = assertValidRegion(str(input.region) || regionFromProfileArn(profileArn) || KIRO_DEFAULT_REGION);

  if (!accessToken) throw new Error('access_token is required');
  if (!refreshToken) throw new Error('refresh_token is required');
  if (!clientId) throw new Error('client_id is required');
  if (!scope) throw new Error('scopes is required');
  if (!profileArn) throw new Error('profile_arn is required');

  return {
    authMethod: 'external_idp',
    accessToken,
    refreshToken,
    expiresAt: expiresAtFrom(input, accessToken),
    region,
    profileArn,
    clientId,
    tokenEndpoint,
    scope,
    email: str(input.email) || emailFromToken(accessToken),
  };
}

/** An AWS SSO token set with its client registration: Builder ID, or IdC when a start URL is given. */
function parseSsoTokenSet(input: Record<string, any>): NewKiroAccount {
  const refreshToken = str(input.refreshToken || input.refresh_token);
  const clientId = str(input.clientId || input.client_id);
  const clientSecret = str(input.clientSecret || input.client_secret);
  if (!refreshToken || !clientId || !clientSecret) {
    throw new Error('An AWS SSO token set needs refreshToken, clientId and clientSecret');
  }
  const startUrl = str(input.startUrl || input.start_url);
  const profileArn = str(input.profileArn || input.profile_arn) || undefined;
  const region = assertValidRegion(str(input.region) || regionFromProfileArn(profileArn) || KIRO_DEFAULT_REGION);
  const isIdc = str(input.authMethod || input.auth_method) === 'idc' || (startUrl !== '' && !startUrl.includes('view.awsapps.com'));
  return {
    authMethod: isIdc ? 'idc' : 'builder-id',
    accessToken: str(input.accessToken || input.access_token),
    refreshToken,
    // Unknown expiry: treat as expired so the validation refresh below runs.
    expiresAt: 0,
    region,
    ...(profileArn ? { profileArn } : {}),
    clientId,
    clientSecret,
    ...(isIdc && startUrl ? { startUrl } : {}),
  };
}

/** Prove a token-bearing credential by renewing it, and keep the renewed tokens. */
async function validateByRefresh(account: NewKiroAccount): Promise<NewKiroAccount> {
  const tokens = await refreshKiroTokens(account);
  return {
    ...account,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken || account.refreshToken,
    expiresAt: Date.now() + (tokens.expiresIn ?? 3600) * 1000,
    ...(tokens.profileArn && !account.profileArn ? { profileArn: tokens.profileArn } : {}),
  };
}

export interface TokenImportInput {
  token: string;
  /** Region for an API key; tokens carry their own. */
  region?: string;
  label?: string;
}

/**
 * Turn a pasted credential into a validated account record, ready for the pool.
 * Throws with an operator-facing reason when the credential is malformed or refused.
 */
export async function importToken(input: TokenImportInput): Promise<NewKiroAccount> {
  const raw = str(input.token);
  if (!raw) throw new Error('Paste a Kiro refresh token, API key or token-set JSON.');
  const label = str(input.label) || undefined;

  if (raw.startsWith('{')) {
    let parsed: Record<string, any>;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('The pasted JSON is not valid.');
    }
    const isExternal = Boolean(parsed.token_endpoint || parsed.tokenEndpoint) ||
      str(parsed.auth_method || parsed.authMethod) === 'external_idp';
    const account = isExternal ? parseExternalIdpAuth(parsed) : parseSsoTokenSet(parsed);
    return { ...(await validateByRefresh(account)), ...(label ? { label } : {}) };
  }

  if (raw.startsWith(SOCIAL_REFRESH_PREFIX)) {
    const tokens = await refreshSocialToken(raw);
    const profileArn = tokens.profileArn?.trim() || undefined;
    return {
      authMethod: 'social',
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken || raw,
      expiresAt: Date.now() + (tokens.expiresIn ?? 3600) * 1000,
      region: regionFromProfileArn(profileArn) ?? KIRO_DEFAULT_REGION,
      ...(profileArn ? { profileArn } : {}),
      ...(label ? { label } : {}),
    };
  }

  const region = assertValidRegion(str(input.region) || KIRO_DEFAULT_REGION);
  const account: NewKiroAccount = { authMethod: 'api_key', accessToken: raw, region, ...(label ? { label } : {}) };
  const models = await fetchModelCatalog(account).catch((error: Error) => {
    throw new Error(`Kiro refused the API key: ${error.message}`);
  });
  if (models.length === 0) throw new Error('Kiro accepted the API key but offers it no models.');
  return account;
}
