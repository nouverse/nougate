/**
 * Which credential answers the next request, and what happens to it afterwards.
 *
 * A tenth the size of the Copilot manager, and the difference is not ambition — it is that this
 * provider has no device flow, no token exchange and no per-account entitlement fetch. The operator
 * hands over a finished credential; everything here is selection and what the upstream said.
 *
 * Three states a credential can be in, and keeping them apart is the whole job:
 *
 *   - **healthy** — offered.
 *   - **cooling** — a 429 said "not right now", per scope, with an expiry. Skipped until it passes,
 *     then offered again with nothing held against it.
 *   - **invalid** — a 401 said the credential itself is finished. Never offered again, and never
 *     silently deleted: an operator who cannot see the dead one cannot tell "expired" from
 *     "I pasted it wrong", and those have different fixes.
 */

import { randomUUID } from 'node:crypto';
import { ConversationAccounts } from '@/core/conversation-accounts';
import type { ClaudeCodeAccount, RateLimitSnapshot, SelectionStrategy } from './types';
import { credentialHint, credentialKind } from './credential';
import { loadConfig, saveConfig } from './storage';

let accounts: ClaudeCodeAccount[] = [];
let strategy: SelectionStrategy = 'healthiest';
let cursor = 0;

/**
 * Health moves on the 0-100 scale every other provider reports.
 *
 * A success recovers less than a failure costs on purpose: one call getting through after a run of
 * failures is not evidence the credential is well, and a score that snapped back to full would hide
 * an account that is flapping.
 */
const HEALTH_MAX = 100;
const HEALTH_RECOVERY = 10;
const HEALTH_PENALTY = 20;

/** Which account each conversation goes back to (`core/conversation-accounts.ts` says why). */
const conversations = new ConversationAccounts();

/**
 * Load the credentials from disk, replacing whatever is in memory.
 *
 * Replaces rather than merges, and that is what makes it safe to call twice: this module holds its
 * accounts in module state, so an init that appended would accumulate every set it had ever seen.
 */
export async function initManager(): Promise<void> {
  const config = await loadConfig();
  accounts = (config.accounts ?? []).map(normalizeHealth);
  strategy = config.strategy ?? 'healthiest';
  cursor = 0;
}

/** The account that answered `conversation`, remembered for its next request. */
export function rememberConversation(conversation: string, accountId: string, now = Date.now()): void {
  conversations.remember(conversation, accountId, now);
}

const persist = (immediate = false) => saveConfig({ accounts, strategy }, { immediate });

/**
 * Bring a stored account onto the 0-100 health scale.
 *
 * Earlier builds kept this provider's health as a 0-1 fraction while every other provider reported
 * 0-100, so a fully healthy credential reached the dashboard as "1%" in an alarm colour. Anything at
 * or below 1 is read as the old fraction and scaled up; anything above is already current.
 */
function normalizeHealth(account: ClaudeCodeAccount): ClaudeCodeAccount {
  if (account.healthScore > 1) return account;
  return { ...account, healthScore: Math.round(account.healthScore * HEALTH_MAX) };
}

/**
 * The account behind an operator-facing identifier.
 *
 * Matches the id first and the label second, because the dashboard addresses accounts by the field
 * it shows — which for this provider is the label, not the uuid. Looking at the id alone is what
 * left Reset, Cooldown and Delete reporting success while matching nothing.
 */
function findAccount(idOrLabel: string): ClaudeCodeAccount | undefined {
  return (
    accounts.find((account) => account.id === idOrLabel) ??
    accounts.find((account) => account.label === idOrLabel)
  );
}

export function getAccounts(): ClaudeCodeAccount[] {
  return accounts;
}

export async function addAccount(credential: string, label?: string): Promise<ClaudeCodeAccount> {
  const value = credential.trim();
  if (!value) throw new Error('a credential is required');

  // Same credential twice is an operator mistake, not a second account: it would double this
  // credential's share of the rotation and halve every other one's, silently.
  const existing = accounts.find((account) => account.credential === value);
  if (existing) return existing;

  const account: ClaudeCodeAccount = {
    id: randomUUID(),
    credential: value,
    kind: credentialKind(value),
    label: label?.trim() || credentialHint(value),
    healthScore: HEALTH_MAX,
    lastUsed: 0,
    consecutiveFailures: 0,
  };
  accounts.push(account);
  await persist(true);
  return account;
}

/**
 * Store an account that came back from the OAuth flow.
 *
 * Separate from `addAccount` rather than a flag on it, because the two produce genuinely different
 * accounts: this one carries a refresh token and an expiry, and can renew itself indefinitely. The
 * pasted kind cannot, and conflating them would mean a `refreshToken` field that is undefined for
 * half the callers and a refresh path that has to keep checking.
 */
export async function addOAuthAccount(input: {
  accessToken: string;
  refreshToken?: string;
  expiresInSeconds?: number;
  label?: string;
}): Promise<ClaudeCodeAccount> {
  const account: ClaudeCodeAccount = {
    id: randomUUID(),
    credential: input.accessToken,
    kind: 'oauth',
    label: input.label?.trim() || credentialHint(input.accessToken),
    healthScore: HEALTH_MAX,
    lastUsed: 0,
    consecutiveFailures: 0,
    ...(input.refreshToken ? { refreshToken: input.refreshToken } : {}),
    ...(input.expiresInSeconds ? { expiresAt: Date.now() + input.expiresInSeconds * 1000 } : {}),
  };
  accounts.push(account);
  await persist(true);
  return account;
}

/**
 * Write a renewed token back onto an account.
 *
 * `refreshToken` is kept when the response omitted one — the server echoes it back only sometimes,
 * and storing `undefined` there would spend the account's ability to ever refresh again on a single
 * successful renewal.
 */
export async function storeRefreshedTokens(
  id: string,
  tokens: { access_token: string; refresh_token?: string; expires_in?: number },
): Promise<void> {
  const account = findAccount(id);
  if (!account) return;

  account.credential = tokens.access_token;
  account.kind = 'oauth';
  if (tokens.refresh_token) account.refreshToken = tokens.refresh_token;
  if (tokens.expires_in) account.expiresAt = Date.now() + tokens.expires_in * 1000;
  // A renewal is evidence the account is well, whatever the last request said.
  delete account.invalidatedAt;
  delete account.invalidReason;
  account.consecutiveFailures = 0;
  await persist(true);
}

/** Whether this token is close enough to expiry to renew before spending a request on it. */
export function needsRefresh(account: ClaudeCodeAccount, leadMs: number): boolean {
  return (
    account.refreshToken !== undefined &&
    account.expiresAt !== undefined &&
    account.expiresAt - Date.now() < leadMs
  );
}

export async function removeAccount(id: string): Promise<boolean> {
  const account = findAccount(id);
  if (!account) return false;
  accounts = accounts.filter((entry) => entry !== account);
  await persist(true);
  return true;
}

/**
 * Bring a credential back after the operator has replaced it.
 *
 * Clears the invalid mark and the cooldowns together — a credential that was rate-limited *and* then
 * replaced is a new credential, and carrying the old one's cooldown into it would leave the operator
 * watching a working key sit idle with no explanation.
 */
export async function replaceCredential(id: string, credential: string): Promise<boolean> {
  const account = findAccount(id);
  if (!account) return false;

  const value = credential.trim();
  if (!value) throw new Error('a credential is required');

  account.credential = value;
  account.kind = credentialKind(value);
  account.healthScore = HEALTH_MAX;
  account.consecutiveFailures = 0;
  delete account.invalidatedAt;
  delete account.invalidReason;
  delete account.cooldowns;
  await persist(true);
  return true;
}

/** The key a cooldown is filed under. Per model, because a limit on one model is not a limit on all. */
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

/**
 * Forget everything the gateway has learned about a credential.
 *
 * Health, failures, cooldowns and the invalid mark clear together, because an operator reaching for
 * Reset is saying "whatever you concluded about this key, drop it" — leaving any one of the four
 * behind keeps the account benched with nothing on screen to explain why.
 */
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

function cooling(account: ClaudeCodeAccount, scope: string): boolean {
  const until = account.cooldowns?.[scope] ?? account.cooldowns?.['account'];
  return until !== undefined && until > Date.now();
}

/**
 * The next credential to try.
 *
 * `excludeIds` is what the executor has already tried this request, so a retry cannot pick the same
 * failing credential twice and burn its attempts on one account. `conversation` is the request's own
 * (the router's session id): the account that answered it last, while it can still be offered, before
 * the strategy is asked, since that account's cache holds the conversation.
 */
export async function getBestAccount(
  modelId?: string,
  excludeIds: string[] = [],
  conversation?: string,
): Promise<ClaudeCodeAccount | null> {
  const scope = cooldownScope(modelId);
  const usable = accounts.filter(
    (account) =>
      !account.invalidatedAt && !excludeIds.includes(account.id) && !cooling(account, scope),
  );
  if (usable.length === 0) return null;

  const kept = conversations.keptAmong(conversation, usable);
  if (kept) return kept;

  if (strategy === 'round-robin') {
    cursor = (cursor + 1) % usable.length;
    return usable[cursor] ?? null;
  }

  // Healthiest, with least-recently-used as the tiebreak — otherwise a pool of equally healthy
  // credentials would send every request to whichever happened to sort first.
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
    // Recovers gradually rather than snapping back to full: one lucky call after a run of failures
    // is not evidence the credential is well, and a score that jumps hides a flapping account.
    account.healthScore = Math.min(HEALTH_MAX, account.healthScore + HEALTH_RECOVERY);
  } else {
    account.consecutiveFailures += 1;
    account.healthScore = Math.max(0, account.healthScore - HEALTH_PENALTY);
  }
  await persist();
}

/**
 * Remember what the rate-limit headers said.
 *
 * Anthropic reports these on every response, so this is free information — and it is the only thing
 * that lets the Quota tab show headroom without spending a request to ask.
 */
export async function recordRateLimit(id: string, headers: Headers): Promise<void> {
  const account = findAccount(id);
  if (!account) return;

  const status = headers.get('anthropic-ratelimit-unified-status') ?? undefined;
  const remaining = numericHeader(headers, 'anthropic-ratelimit-unified-remaining');
  const limit = numericHeader(headers, 'anthropic-ratelimit-unified-limit');
  const reset = headers.get('anthropic-ratelimit-unified-reset');

  // Nothing reported means nothing recorded. Writing zeroes here would draw an empty quota bar for a
  // plan that never said it had a limit — a reading invented from a silence.
  if (!status && remaining === undefined && limit === undefined) return;

  const snapshot: RateLimitSnapshot = { observedAt: Date.now() };
  if (status) snapshot.status = status;
  if (remaining !== undefined) snapshot.remaining = remaining;
  if (limit !== undefined) snapshot.limit = limit;
  if (reset) {
    const at = Date.parse(reset);
    if (Number.isFinite(at)) snapshot.resetsAt = at;
  }

  account.rateLimit = snapshot;
  await persist();
}

/**
 * A numeric header, or `undefined` when it was not sent.
 *
 * `Number(headers.get(x))` cannot express this: `get` returns `null` for an absent header and
 * `Number(null)` is **0**, which passes `Number.isFinite` — so a response carrying no rate-limit
 * headers at all reads as a credential with zero requests remaining, and the dashboard draws an
 * empty bar for a plan that never claimed a limit.
 */
function numericHeader(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw === null || raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}
