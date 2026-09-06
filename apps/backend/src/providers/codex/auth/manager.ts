/**
 * Codex account manager: selection, rotation, health scoring, and credential lifecycle.
 *
 * Similar to claude-code's manager but with Codex-specific concerns:
 * - Accounts carry `chatgptAccountId`, `idToken`, `lastRefreshAt`
 * - Proactive stale refresh via `maxRefreshAgeMs` / `lastRefreshAt`
 */

import { randomUUID } from 'node:crypto';
import type { CodexAccount, SelectionStrategy } from './types';
import { credentialHint, decodeAccountId } from './credential';
import { CODEX_OAUTH, isRefreshStale } from './oauth';
import { loadConfig, saveConfig } from './storage';

let accounts: CodexAccount[] = [];
let strategy: SelectionStrategy = 'healthiest';
let cursor = 0;

const HEALTH_MAX = 100;
const HEALTH_RECOVERY = 10;
const HEALTH_PENALTY = 20;

export async function initManager(): Promise<void> {
  const config = await loadConfig();
  accounts = config.accounts ?? [];
  strategy = config.strategy ?? 'healthiest';
  cursor = 0;
}

const persist = (immediate = false) => saveConfig({ accounts, strategy }, { immediate });

function findAccount(idOrLabel: string): CodexAccount | undefined {
  return (
    accounts.find((account) => account.id === idOrLabel) ??
    accounts.find((account) => account.label === idOrLabel)
  );
}

export function getAccounts(): CodexAccount[] {
  return accounts;
}

/**
 * Store an account that came from the OAuth flow.
 *
 * Decodes `chatgptAccountId` from the id_token JWT on import.
 */
export async function addOAuthAccount(input: {
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  expiresInSeconds?: number;
  label?: string;
}): Promise<CodexAccount> {
  const chatgptAccountId = decodeAccountId(input.idToken) ?? undefined;

  const account: CodexAccount = {
    id: randomUUID(),
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    idToken: input.idToken,
    chatgptAccountId,
    label: input.label?.trim() || credentialHint(input.accessToken),
    healthScore: HEALTH_MAX,
    lastUsed: 0,
    consecutiveFailures: 0,
    lastRefreshAt: Date.now(),
    ...(input.expiresInSeconds ? { expiresAt: Date.now() + input.expiresInSeconds * 1000 } : {}),
  };
  accounts.push(account);
  await persist(true);
  return account;
}

/**
 * Write renewed tokens back onto an account.
 *
 * `refresh_token` is kept when the response omitted one.
 * `id_token` is updated when present, and `chatgptAccountId` re-decoded.
 * `lastRefreshAt` is always stamped (trackRefreshAt).
 */
export async function storeRefreshedTokens(
  id: string,
  tokens: { access_token: string; refresh_token?: string; id_token?: string; expires_in?: number },
): Promise<void> {
  const account = findAccount(id);
  if (!account) return;

  account.accessToken = tokens.access_token;
  if (tokens.refresh_token) account.refreshToken = tokens.refresh_token;
  if (tokens.id_token) {
    account.idToken = tokens.id_token;
    const decoded = decodeAccountId(tokens.id_token);
    if (decoded) account.chatgptAccountId = decoded;
  }
  if (tokens.expires_in) account.expiresAt = Date.now() + tokens.expires_in * 1000;
  account.lastRefreshAt = Date.now();
  delete account.invalidatedAt;
  delete account.invalidReason;
  account.consecutiveFailures = 0;
  await persist(true);
}

/** Whether this token needs refresh — either expiry-based or staleness-based. */
export function needsRefresh(account: CodexAccount): boolean {
  const now = Date.now();
  if (account.expiresAt !== undefined && account.expiresAt - now < CODEX_OAUTH.refreshLeadMs) {
    return true;
  }
  if (isRefreshStale(account.lastRefreshAt, now)) return true;
  return false;
}

export async function removeAccount(id: string): Promise<boolean> {
  const account = findAccount(id);
  if (!account) return false;
  accounts = accounts.filter((entry) => entry !== account);
  await persist(true);
  return true;
}

export async function resetAccount(id: string): Promise<boolean> {
  const account = findAccount(id);
  if (!account) return false;
  account.healthScore = HEALTH_MAX;
  account.consecutiveFailures = 0;
  delete account.cooldowns;
  delete account.invalidatedAt;
  delete account.invalidReason;
  await persist(true);
  return true;
}

export async function invalidate(id: string, reason: string): Promise<void> {
  const account = findAccount(id);
  if (!account || account.invalidatedAt) return;
  account.invalidatedAt = Date.now();
  account.invalidReason = reason;
  account.healthScore = 0;
  await persist(true);
}

export function cooldownScope(modelId?: string): string {
  return modelId ?? 'account';
}

export async function markCooldown(id: string, scope: string, ms: number): Promise<boolean> {
  const account = findAccount(id);
  if (!account) return false;
  account.cooldowns = { ...account.cooldowns, [scope]: Date.now() + ms };
  await persist(true);
  return true;
}

function cooling(account: CodexAccount, scope: string): boolean {
  const until = account.cooldowns?.[scope] ?? account.cooldowns?.['account'];
  return until !== undefined && until > Date.now();
}

export async function getBestAccount(
  modelId?: string,
  excludeIds: string[] = [],
): Promise<CodexAccount | null> {
  const scope = cooldownScope(modelId);
  const usable = accounts.filter(
    (account) =>
      !account.invalidatedAt && !excludeIds.includes(account.id) && !cooling(account, scope),
  );
  if (usable.length === 0) return null;

  if (strategy === 'round-robin') {
    cursor = (cursor + 1) % usable.length;
    return usable[cursor] ?? null;
  }

  return usable.reduce((best, account) =>
    account.healthScore !== best.healthScore
      ? account.healthScore > best.healthScore
        ? account
        : best
      : account.lastUsed < best.lastUsed
        ? account
        : best,
  );
}

export async function updateAccountUsage(id: string, success: boolean): Promise<void> {
  const account = findAccount(id);
  if (!account) return;

  account.lastUsed = Date.now();
  if (success) {
    account.consecutiveFailures = 0;
    account.healthScore = Math.min(HEALTH_MAX, account.healthScore + HEALTH_RECOVERY);
  } else {
    account.consecutiveFailures += 1;
    account.healthScore = Math.max(0, account.healthScore - HEALTH_PENALTY);
  }
  await persist();
}
