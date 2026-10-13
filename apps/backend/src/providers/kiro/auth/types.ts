/**
 * One Kiro credential and what the gateway has learned about it.
 *
 * Kiro sits on AWS CodeWhisperer, and an account can arrive five different ways. Each way decides
 * how the token is renewed, which upstream surface accepts it, and which headers must accompany it,
 * so the method is stored rather than re-guessed from the token's shape on every request.
 */

/**
 * - `builder-id`   — AWS Builder ID, through the SSO OIDC device flow.
 * - `idc`          — IAM Identity Center, the same device flow against an organisation's start URL.
 * - `social`       — a Kiro desktop refresh token (Google/GitHub sign-in), pasted.
 * - `api_key`      — a long-lived Kiro API key, pasted. Sent as a bearer with `TokenType: API_KEY`.
 * - `external_idp` — an enterprise (Microsoft Entra) token set, pasted as JSON. Sent with
 *                    `TokenType: EXTERNAL_IDP`, renewed against the Microsoft token endpoint.
 */
export type KiroAuthMethod = 'builder-id' | 'idc' | 'social' | 'api_key' | 'external_idp';

export interface KiroAccount {
  id: string;
  /** Operator-facing name: the email when one is known, otherwise a token fingerprint. */
  label: string;
  email?: string;
  authMethod: KiroAuthMethod;

  /** Bearer credential. For `api_key` accounts this *is* the key. */
  accessToken: string;
  refreshToken?: string;
  /** Access-token expiry, epoch ms. Absent for API keys, which do not expire on a clock. */
  expiresAt?: number;

  /** AWS region the credential was minted in; upstream hosts are regionalised to it. */
  region: string;
  /** CodeWhisperer profile this credential is bound to, once resolved. */
  profileArn?: string;

  /** SSO OIDC client registration — `builder-id` and `idc` renew with these. */
  clientId?: string;
  clientSecret?: string;
  clientSecretExpiresAt?: number;
  /** The IAM Identity Center start URL, for `idc`. */
  startUrl?: string;

  /** `external_idp` renewal: the Microsoft token endpoint and the scope string to request. */
  tokenEndpoint?: string;
  scope?: string;

  healthScore: number;
  lastUsed: number;
  consecutiveFailures: number;
  /** Per-scope cooldown expiry, epoch ms. Scope is a model id, or `*` for the whole account. */
  cooldowns?: Record<string, number>;
  /** Set when the credential is finished and only a re-login will help. */
  invalidatedAt?: number;
  invalidReason?: string;
  modelScores?: Record<string, number>;
  tokenUsage?: number;
}

export type SelectionStrategy = 'healthiest' | 'round-robin';

export interface KiroAccountsFile {
  accounts: KiroAccount[];
  strategy?: SelectionStrategy;
}

/** Tokens returned by any renewal path, normalised. */
export interface KiroTokenSet {
  accessToken: string;
  refreshToken?: string;
  /** Seconds. */
  expiresIn?: number;
  profileArn?: string;
}

/** What the dashboard is shown to start a device login. Snake case: the shared tab reads it so. */
export interface KiroDeviceFlowStart {
  step: 'device_flow';
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}
