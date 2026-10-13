/**
 * Every upstream URL Kiro uses, and the rules for choosing between them.
 *
 * Code, not config: a typo in any of these takes the provider down, and the Provider Config tab's
 * JSON editor has no way to say so.
 */

import type { KiroAccount, KiroAuthMethod } from '../auth/types';

export const KIRO_DEFAULT_REGION = 'us-east-1';

/**
 * A region is interpolated into hostnames, so it is validated rather than trusted: `evil.com/x`
 * would otherwise send the bearer token to an attacker-chosen origin.
 */
const AWS_REGION_PATTERN = /^[a-z]{2}(?:-gov)?-[a-z]+-\d{1,2}$/;

export function assertValidRegion(region: string): string {
  if (typeof region !== 'string' || !AWS_REGION_PATTERN.test(region)) {
    throw new Error(`Invalid AWS region "${String(region).slice(0, 40)}"`);
  }
  return region;
}

/** Region from `arn:aws:codewhisperer:<region>:<account>:profile/<id>`. */
export function regionFromProfileArn(profileArn: string | undefined): string | null {
  const region = profileArn?.split(':')[3];
  return region && AWS_REGION_PATTERN.test(region) ? region : null;
}

// ─── Chat ──────────────────────────────────────────────────────────────────

/**
 * The three surfaces of `GenerateAssistantResponse`. They are one regional service behind three
 * front doors, which accept different token families:
 *
 *   - `q.*`              — Amazon Q. The only one that runs inference for API keys.
 *   - `codewhisperer.*`  — needs `X-Amz-Target`; the home of IdC and external-IdP tokens.
 *   - `runtime.*.kiro.dev` — the Kiro IDE gateway. Its legacy path answers modern payloads with
 *                            400 REQUEST_BODY_INVALID since IDE 1.0.228, so it is tried last.
 */
const CHAT_URLS = {
  q: (region: string) => `https://q.${region}.amazonaws.com/generateAssistantResponse`,
  codewhisperer: (region: string) => `https://codewhisperer.${region}.amazonaws.com/generateAssistantResponse`,
  // The IDE gateway exists only in us-east-1.
  kiro: () => 'https://runtime.us-east-1.kiro.dev/generateAssistantResponse',
} as const;

export type KiroSurface = keyof typeof CHAT_URLS;

export interface KiroChatEndpoint {
  surface: KiroSurface;
  url: string;
}

/**
 * Surfaces to try, in order, for one account.
 *
 * Amazon surfaces reject a foreign token with 401/403, which falls through to the next; the Kiro
 * gateway's 400 does not, because a 400 is otherwise a payload problem that every surface would
 * repeat. So the Amazon surfaces always go first, and `q.*` leads among them.
 */
export function chatEndpoints(account: Pick<KiroAccount, 'region' | 'authMethod'>): KiroChatEndpoint[] {
  const region = assertValidRegion(account.region || KIRO_DEFAULT_REGION);
  const order: KiroSurface[] =
    account.authMethod === 'api_key' ? ['q', 'codewhisperer'] : ['q', 'codewhisperer', 'kiro'];
  return order.map((surface) => ({ surface, url: CHAT_URLS[surface](region) }));
}

/**
 * Statuses that mean "this front door does not take this token", so the next one is worth trying.
 * A 400 is deliberately absent: the same body would be refused everywhere.
 */
export const SURFACE_FALLBACK_STATUSES: ReadonlySet<number> = new Set([401, 403, 404]);

// ─── Account services ──────────────────────────────────────────────────────

export const codewhispererHost = (region: string) => `https://codewhisperer.${assertValidRegion(region)}.amazonaws.com`;
export const qHost = (region: string) => `https://q.${assertValidRegion(region)}.amazonaws.com`;

export const KIRO_USAGE_LIMITS_PATH = '/getUsageLimits';
export const KIRO_LIST_MODELS_PATH = '/ListAvailableModels';

// ─── Auth ──────────────────────────────────────────────────────────────────

/** AWS SSO OIDC, for Builder ID and IAM Identity Center device logins and their renewal. */
export const oidcEndpoints = (region: string) => {
  const base = `https://oidc.${assertValidRegion(region)}.amazonaws.com`;
  return {
    register: `${base}/client/register`,
    deviceAuthorization: `${base}/device_authorization`,
    token: `${base}/token`,
  };
};

/** Kiro's desktop auth service — renews refresh tokens from Google/GitHub sign-ins. */
export const KIRO_SOCIAL_REFRESH_URL = 'https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken';

/** The AWS Builder ID start URL. IAM Identity Center logins bring their own. */
export const BUILDER_ID_START_URL = 'https://view.awsapps.com/start';

/** What the OIDC client registers as. Kiro's own IDE registers the same way. */
export const KIRO_OIDC_CLIENT = {
  clientName: 'kiro-oauth-client',
  clientType: 'public',
  scopes: ['codewhisperer:completions', 'codewhisperer:analysis', 'codewhisperer:conversations'],
  grantTypes: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
  issuerUrl: 'https://identitycenter.amazonaws.com/ssoins-722374e8c3c8e6c6',
} as const;

/** Hosts an `external_idp` token may be renewed against. Anything else is refused. */
export const MICROSOFT_TOKEN_HOSTS: ReadonlySet<string> = new Set([
  'login.microsoftonline.com',
  'login.microsoft.com',
  'login.windows.net',
]);

// ─── Profiles ──────────────────────────────────────────────────────────────

/**
 * Shared CodeWhisperer profiles, used when an OAuth account cannot resolve its own. Builder ID and
 * social sign-ins map to different ones.
 */
const DEFAULT_PROFILE_ARNS = {
  builderId: 'arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX',
  social: 'arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK',
} as const;

/**
 * Whether a method's token is bound to one account's profile. Sending such a token with a shared
 * default ARN is a 403 "bearer token invalid" — the ARN belongs to somebody else.
 */
export function isAccountBoundAuth(method: KiroAuthMethod): boolean {
  return method === 'api_key' || method === 'idc' || method === 'external_idp';
}

/**
 * The profile ARN to send: the account's own when known; for OAuth-family methods the shared
 * default; for account-bound methods nothing, so the token's own default profile applies.
 */
export function resolveProfileArn(account: Pick<KiroAccount, 'authMethod' | 'profileArn'>): string | undefined {
  if (account.profileArn) return account.profileArn;
  if (isAccountBoundAuth(account.authMethod)) return undefined;
  return account.authMethod === 'social' ? DEFAULT_PROFILE_ARNS.social : DEFAULT_PROFILE_ARNS.builderId;
}
