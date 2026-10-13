/**
 * Header sets Kiro's upstream validates.
 *
 * Two shapes, because two different clients are being matched: chat calls look like the Kiro IDE's
 * runtime SDK; account calls (`ListAvailableModels`, quota) carry the IDE's per-machine
 * fingerprint, and are refused with a 400 about the User-Agent format when it is malformed.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { KiroAccount } from '../auth/types';
import type { KiroSurface } from './endpoints';
import { resolveProfileArn } from './endpoints';

const CODEWHISPERER_TARGET = 'AmazonCodeWhispererStreamingService.GenerateAssistantResponse';

const RUNTIME_USER_AGENT = 'AWS-SDK-JS/3.0.0 kiro-ide/1.0.0';
const RUNTIME_AMZ_USER_AGENT = 'aws-sdk-js/3.0.0 kiro-ide/1.0.0';

/** The runtime SDK fingerprint the IDE reports alongside its version. */
const FINGERPRINT = {
  sdkVersion: '1.0.0',
  os: 'windows',
  osVersion: '10.0.26200',
  nodeVersion: '22.21.1',
} as const;

/**
 * Bearer plus the token-type marker the method needs.
 *
 * API keys go out as a bearer like any access token, but CodeWhisperer only treats them as
 * long-lived keys with `TokenType: API_KEY`; enterprise tokens need `EXTERNAL_IDP` to bind to their
 * profile. Everything else is a plain OIDC/social bearer.
 */
export function authHeaders(account: Pick<KiroAccount, 'authMethod' | 'accessToken'>): Record<string, string> {
  const headers: Record<string, string> = { Authorization: `Bearer ${account.accessToken}` };
  if (account.authMethod === 'api_key') headers.TokenType = 'API_KEY';
  if (account.authMethod === 'external_idp') headers.TokenType = 'EXTERNAL_IDP';
  return headers;
}

/** Headers for one `GenerateAssistantResponse` call against one surface. */
export function buildChatHeaders(
  account: Pick<KiroAccount, 'authMethod' | 'accessToken' | 'profileArn'>,
  surface: KiroSurface,
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/vnd.amazon.eventstream',
    'User-Agent': RUNTIME_USER_AGENT,
    'X-Amz-User-Agent': RUNTIME_AMZ_USER_AGENT,
    'Amz-Sdk-Request': 'attempt=1; max=3',
    'Amz-Sdk-Invocation-Id': randomUUID(),
    ...authHeaders(account),
    // The Amazon surfaces accept the SSO bearer and the agent-mode marker the IDE sends; without
    // them the path gateway answers modern payloads with REQUEST_BODY_INVALID.
    'x-amz-sso-bearer': account.accessToken,
    'x-amzn-kiro-agent-mode': 'spec',
    'x-amzn-codewhisperer-machine-id': 'kiro-desktop',
  };
  if (surface === 'codewhisperer') headers['X-Amz-Target'] = CODEWHISPERER_TARGET;
  const profileArn = resolveProfileArn(account);
  if (profileArn) headers['x-amzn-codewhisperer-profile-arn'] = profileArn;
  return headers;
}

/**
 * A stable per-account machine id: the same account always presents the same one, and two accounts
 * never share it. Derived from the most stable identifier the credential has; the hash is one-way,
 * so no secret is recoverable from the header.
 */
export function machineId(account: Pick<KiroAccount, 'clientId' | 'refreshToken' | 'profileArn' | 'accessToken'>): string {
  const seed = account.clientId || account.refreshToken || account.profileArn || account.accessToken || 'kiro-anonymous';
  return createHash('sha256').update(String(seed)).digest('hex');
}

/** Headers for account-level calls, in the IDE's fingerprinted form. */
export function buildFingerprintHeaders(
  account: Pick<KiroAccount, 'authMethod' | 'accessToken' | 'clientId' | 'refreshToken' | 'profileArn'>,
  ideVersion: string,
): Record<string, string> {
  const id = machineId(account);
  const userAgent =
    `aws-sdk-js/${FINGERPRINT.sdkVersion} ua/2.1 ` +
    `os/${FINGERPRINT.os}#${FINGERPRINT.osVersion} ` +
    `lang/js md/nodejs#${FINGERPRINT.nodeVersion} ` +
    `api/codewhispererruntime#${FINGERPRINT.sdkVersion} m/N,E ` +
    `KiroIDE-${ideVersion}-${id}`;
  return {
    'User-Agent': userAgent,
    'x-amz-user-agent': `aws-sdk-js/${FINGERPRINT.sdkVersion} KiroIDE-${ideVersion}-${id}`,
    'x-amzn-kiro-agent-mode': 'vibe',
    'x-amzn-codewhisperer-optout': 'true',
    'amz-sdk-request': 'attempt=1; max=1',
    'amz-sdk-invocation-id': randomUUID(),
    Accept: 'application/json',
    ...authHeaders(account),
  };
}
