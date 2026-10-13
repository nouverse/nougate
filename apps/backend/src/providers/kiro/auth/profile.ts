/**
 * Account-level lookups: which CodeWhisperer profile a token belongs to, and which models it may
 * call. Both are needed at sign-in; the model list also feeds the live catalogue.
 */

import { getKiroConfig } from '../config/provider-config';
import { codewhispererHost, KIRO_LIST_MODELS_PATH, qHost, regionFromProfileArn } from '../upstream/endpoints';
import { authHeaders, buildFingerprintHeaders } from '../upstream/headers';
import type { KiroCatalogEntry } from '../config/model-specs';
import type { KiroAccount } from './types';

const LOOKUP_TIMEOUT_MS = 30_000;

type TokenFields = Pick<KiroAccount, 'authMethod' | 'accessToken' | 'region'> &
  Partial<Pick<KiroAccount, 'clientId' | 'refreshToken' | 'profileArn'>>;

/**
 * The profile ARN this token is bound to, preferring one in the token's own region.
 *
 * Not available for API keys: `ListAvailableProfiles` does not accept `TokenType: API_KEY`, and a
 * key needs no profile to run inference.
 */
export async function fetchProfileArn(account: TokenFields): Promise<string | null> {
  if (account.authMethod === 'api_key') return null;
  const response = await fetch(codewhispererHost(account.region), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.0',
      'x-amz-target': 'AmazonCodeWhispererService.ListAvailableProfiles',
      Accept: 'application/json',
      ...authHeaders(account),
    },
    body: JSON.stringify({ maxResults: 10 }),
    signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`ListAvailableProfiles returned ${response.status}`);
  }
  const data = (await response.json()) as { profiles?: Array<{ arn?: string; profileArn?: string }> };
  const arnOf = (profile: { arn?: string; profileArn?: string }) => (profile.arn || profile.profileArn)?.trim() || null;
  const profiles = Array.isArray(data.profiles) ? data.profiles : [];
  const match = profiles.find((profile) => regionFromProfileArn(arnOf(profile) ?? undefined) === account.region) ?? profiles[0];
  return match ? arnOf(match) : null;
}

/**
 * The model catalogue this credential may call.
 *
 * Also the only proof an API key works: a bearer-only `ListAvailableProfiles` can answer 200 with an
 * empty list for an arbitrary string, so import validates keys here instead.
 */
export async function fetchModelCatalog(account: TokenFields): Promise<KiroCatalogEntry[]> {
  const region = regionFromProfileArn(account.profileArn) ?? account.region;
  const params = new URLSearchParams({ origin: 'AI_EDITOR' });
  if (account.profileArn) params.set('profileArn', account.profileArn);
  const response = await fetch(`${qHost(region)}${KIRO_LIST_MODELS_PATH}?${params}`, {
    method: 'GET',
    headers: buildFingerprintHeaders(account, getKiroConfig().ideVersion),
    signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw Object.assign(new Error(`ListAvailableModels returned ${response.status}: ${text.slice(0, 200)}`), {
      status: response.status,
    });
  }
  const data = (await response.json()) as { models?: KiroCatalogEntry[] };
  return Array.isArray(data.models) ? data.models : [];
}
