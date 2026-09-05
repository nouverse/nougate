/**
 * What kind of credential the operator pasted, and the headers it implies.
 *
 * Anthropic accepts two, and they are *not* interchangeable — sending one on the other's header is a
 * 401 that reads like an expired key:
 *
 *   - **API key** (`sk-ant-api…`) — `x-api-key`. Bills against API credits. Long-lived.
 *   - **OAuth access token** — `Authorization: Bearer`, **plus** `anthropic-beta: oauth-2025-04-20`.
 *     Bills against the operator's Claude subscription. Short-lived, hours not months.
 *
 * The beta header is the part that gets forgotten. It is endpoint-dependent — some endpoints happen
 * to work without it — but `/v1/messages`, which is the only one this provider calls, does not.
 * Converting a working curl from a key to a token is a *header* change, not a credential swap.
 *
 * ## Why the kind is sniffed rather than asked for
 *
 * The dashboard's `api-key` account flow is one paste field, and it is the flow this provider
 * declares. A second "which kind is this?" control would be a field the operator can contradict —
 * and the credential already says what it is. An Anthropic API key carries a documented `sk-ant-api`
 * prefix; an OAuth token does not. Guessing wrong is recoverable and loud (401 on the first call),
 * where a mislabelled dropdown is silent.
 */

export type CredentialKind = 'api-key' | 'oauth';

/** The documented prefix on an Anthropic API key. Anything else is treated as a bearer token. */
const API_KEY_PREFIX = 'sk-ant-api';

export function credentialKind(credential: string): CredentialKind {
  return credential.trim().startsWith(API_KEY_PREFIX) ? 'api-key' : 'oauth';
}

/**
 * The auth headers for one credential.
 *
 * `anthropic-version` is on both because it is required by the API regardless of how the caller
 * authenticated, and omitting it is a 400 rather than a default.
 */
export function authHeaders(credential: string): Record<string, string> {
  const value = credential.trim();
  if (credentialKind(value) === 'api-key') {
    return { 'x-api-key': value, 'anthropic-version': ANTHROPIC_VERSION };
  }
  return {
    authorization: `Bearer ${value}`,
    'anthropic-version': ANTHROPIC_VERSION,
    // Required on /v1/messages for an OAuth token. Without it the request 401s while the token is
    // perfectly valid, which is the single most confusing failure on this path.
    'anthropic-beta': OAUTH_BETA,
  };
}

export const ANTHROPIC_VERSION = '2023-06-01';
export const OAUTH_BETA = 'oauth-2025-04-20';

/**
 * A short, non-reversible fingerprint, for logs and the dashboard list.
 *
 * Never the credential. These end up in a JSON file, a log line and an HTTP response, and a token
 * that reaches any of those is a token that has to be rotated.
 */
export function credentialHint(credential: string): string {
  const value = credential.trim();
  return value.length <= 8 ? '…' : `${value.slice(0, 4)}…${value.slice(-4)}`;
}
