/**
 * AWS SSO OIDC device authorization — how Builder ID and IAM Identity Center accounts sign in.
 *
 *   1. Register a public OIDC client (yields a client id and secret, valid for ~90 days).
 *   2. Start a device authorization against a start URL; the operator opens the verification URL
 *      and approves the user code.
 *   3. Poll `CreateToken` with the device code until AWS answers with tokens.
 *
 * The client secret never leaves the gateway: between steps 2 and 3 it is held here, keyed by the
 * device code the dashboard echoes back, and dropped when the code expires.
 */

import { BUILDER_ID_START_URL, KIRO_DEFAULT_REGION, KIRO_OIDC_CLIENT, assertValidRegion, oidcEndpoints } from '../upstream/endpoints';
import type { KiroAuthMethod, KiroDeviceFlowStart } from './types';

const DEVICE_TIMEOUT_MS = 30_000;

interface PendingDeviceLogin {
  authMethod: Extract<KiroAuthMethod, 'builder-id' | 'idc'>;
  region: string;
  startUrl: string;
  clientId: string;
  clientSecret: string;
  clientSecretExpiresAt?: number;
  expiresAt: number;
}

const pending = new Map<string, PendingDeviceLogin>();

function prune(now = Date.now()): void {
  for (const [code, login] of pending) if (login.expiresAt <= now) pending.delete(code);
}

async function postJson(url: string, body: unknown): Promise<{ status: number; data: any }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(DEVICE_TIMEOUT_MS),
  });
  const text = await response.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { message: text };
  }
  return { status: response.status, data };
}

/** The start URL must be an https URL; it is handed to AWS, which redirects the operator to it. */
function validateStartUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error('startUrl must be a valid URL');
  }
  if (parsed.protocol !== 'https:') throw new Error('startUrl must use https');
  return parsed.toString().replace(/\/$/, '');
}

/**
 * Begin a device login. No `startUrl` means AWS Builder ID; one means IAM Identity Center, in the
 * region the organisation's directory lives in.
 */
export async function startDeviceFlow(options: { startUrl?: string; region?: string } = {}): Promise<KiroDeviceFlowStart> {
  prune();
  const isIdc = Boolean(options.startUrl?.trim());
  const region = assertValidRegion(options.region?.trim() || KIRO_DEFAULT_REGION);
  const startUrl = isIdc ? validateStartUrl(options.startUrl!) : BUILDER_ID_START_URL;
  const endpoints = oidcEndpoints(region);

  const registered = await postJson(endpoints.register, KIRO_OIDC_CLIENT);
  if (registered.status !== 200 || !registered.data?.clientId) {
    throw new Error(`AWS refused the OIDC client registration (${registered.status})`);
  }

  const authorization = await postJson(endpoints.deviceAuthorization, {
    clientId: registered.data.clientId,
    clientSecret: registered.data.clientSecret,
    startUrl,
  });
  if (authorization.status !== 200 || !authorization.data?.deviceCode) {
    throw new Error(`AWS refused the device authorization (${authorization.status})`);
  }

  const data = authorization.data;
  const expiresIn = Number(data.expiresIn) || 600;
  pending.set(data.deviceCode, {
    authMethod: isIdc ? 'idc' : 'builder-id',
    region,
    startUrl,
    clientId: registered.data.clientId,
    clientSecret: registered.data.clientSecret,
    ...(registered.data.clientSecretExpiresAt
      ? { clientSecretExpiresAt: Number(registered.data.clientSecretExpiresAt) * 1000 }
      : {}),
    expiresAt: Date.now() + expiresIn * 1000,
  });

  return {
    step: 'device_flow',
    device_code: data.deviceCode,
    user_code: data.userCode,
    verification_uri: data.verificationUri,
    ...(data.verificationUriComplete ? { verification_uri_complete: data.verificationUriComplete } : {}),
    expires_in: expiresIn,
    interval: Number(data.interval) || 5,
  };
}

export type DevicePollResult =
  | { status: 'pending'; error: string }
  | { status: 'expired'; error: string }
  | {
      status: 'success';
      login: Omit<PendingDeviceLogin, 'expiresAt'>;
      tokens: { accessToken: string; refreshToken?: string; expiresIn?: number };
    };

/**
 * Ask AWS whether the operator has approved yet. Safe to call repeatedly; the pending login is
 * consumed only by a success or a terminal refusal.
 */
export async function pollDeviceFlow(deviceCode: string): Promise<DevicePollResult> {
  prune();
  const login = pending.get(deviceCode);
  if (!login) return { status: 'expired', error: 'This sign-in has expired or was never started. Start again.' };

  const { status, data } = await postJson(oidcEndpoints(login.region).token, {
    clientId: login.clientId,
    clientSecret: login.clientSecret,
    deviceCode,
    grantType: 'urn:ietf:params:oauth:grant-type:device_code',
  });

  if (status === 200 && data?.accessToken) {
    pending.delete(deviceCode);
    const { expiresAt: _expiresAt, ...rest } = login;
    return {
      status: 'success',
      login: rest,
      tokens: { accessToken: data.accessToken, refreshToken: data.refreshToken, expiresIn: data.expiresIn },
    };
  }

  const error = String(data?.error || '');
  if (error === 'authorization_pending' || error === 'slow_down') {
    return { status: 'pending', error };
  }
  pending.delete(deviceCode);
  return { status: 'expired', error: data?.error_description || error || `AWS answered ${status}` };
}

/** For tests. */
export function clearPendingDeviceLogins(): void {
  pending.clear();
}
