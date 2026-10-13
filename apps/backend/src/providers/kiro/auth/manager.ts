/**
 * Kiro account pool: selection, rotation, health scoring, cooldowns and credential storage.
 *
 * A class rather than module state so the whole lifecycle is testable without touching the data
 * directory or the global config: persistence and scoring are handed in. The provider uses the one
 * module-level instance at the bottom of this file.
 */

import { randomUUID } from 'node:crypto';
import { getProxyConfig } from '@/config/manager';
import type { RotationConfig, ScoringConfig } from '@/config/types';
import { adminEventBus } from '@/core/events';
import { assertAccountSlotAvailable, capRotationPool } from '@/core/rotation-pool';
import { loadAccountsFile, saveAccountsFile } from './storage';
import type { KiroAccount, KiroAccountsFile, KiroTokenSet, SelectionStrategy } from './types';

/** Cooldown scope meaning "this whole account is out", not one model. */
export const ACCOUNT_WIDE = '*';

export function cooldownScope(modelId?: string): string {
  return modelId ? modelId.trim().toLowerCase() : ACCOUNT_WIDE;
}

/** A short, non-reversible fingerprint for logs and the dashboard. Never the token itself. */
export function credentialHint(secret: string): string {
  const value = secret.trim();
  return value.length <= 12 ? '…' : `${value.slice(0, 4)}…${value.slice(-4)}`;
}

/** What a sign-in produced, before the pool gives it an id and a health record. */
export type NewKiroAccount = Omit<
  KiroAccount,
  'id' | 'label' | 'healthScore' | 'lastUsed' | 'consecutiveFailures'
> & { label?: string };

export interface KiroPoolDeps {
  persist(data: KiroAccountsFile, immediate: boolean): void;
  scoring(): ScoringConfig;
  rotation(): RotationConfig;
  /** Told whenever accounts or cooldowns change, so the dashboard's SSE feed stays live. */
  notify?(event: 'update' | 'cooldown', payload: unknown): void;
}

export class KiroAccountPool {
  private accounts: KiroAccount[] = [];
  private strategy: SelectionStrategy = 'healthiest';
  private cursor = 0;
  private readonly sticky = new Map<string, string>();

  constructor(private readonly deps: KiroPoolDeps) {}

  load(file: KiroAccountsFile): void {
    this.accounts = Array.isArray(file.accounts) ? file.accounts : [];
    this.strategy = file.strategy ?? 'healthiest';
    this.cursor = 0;
    this.sticky.clear();
  }

  list(): KiroAccount[] {
    return this.accounts;
  }

  find(id: string): KiroAccount | undefined {
    return this.accounts.find((account) => account.id === id);
  }

  getStrategy(): SelectionStrategy {
    return this.strategy;
  }

  setStrategy(strategy: SelectionStrategy): void {
    this.strategy = strategy;
    this.persist(true);
  }

  private persist(immediate = false): void {
    this.deps.persist({ accounts: this.accounts, strategy: this.strategy }, immediate);
    this.deps.notify?.('update', { accounts: this.accounts, strategy: this.strategy });
  }

  /**
   * The account a new sign-in describes, if the pool already holds it.
   *
   * Matched by email within the same method first, then by the refresh token, then — for keys —
   * by the key itself. Signing in again is therefore an update, and never counts against the
   * account cap.
   */
  private match(input: NewKiroAccount): KiroAccount | undefined {
    return this.accounts.find((account) => {
      if (account.authMethod !== input.authMethod) return false;
      if (input.email && account.email && account.email === input.email) return true;
      if (input.refreshToken && account.refreshToken === input.refreshToken) return true;
      return input.authMethod === 'api_key' && account.accessToken === input.accessToken;
    });
  }

  /**
   * Store a credential. A re-authentication updates in place; a new one is checked against
   * `MAX_ACCOUNT_MULTIPLEXING` here, at the one point every add path goes through.
   */
  upsert(input: NewKiroAccount): KiroAccount {
    const existing = this.match(input);
    const label = input.label?.trim() || input.email || credentialHint(input.refreshToken || input.accessToken);

    if (existing) {
      Object.assign(existing, input, { label });
      delete existing.invalidatedAt;
      delete existing.invalidReason;
      existing.consecutiveFailures = 0;
      this.persist(true);
      return existing;
    }

    assertAccountSlotAvailable('Kiro account', this.accounts.length);
    const account: KiroAccount = {
      ...input,
      id: randomUUID(),
      label,
      healthScore: this.deps.scoring().healthRange.initial,
      lastUsed: 0,
      consecutiveFailures: 0,
    };
    this.accounts.push(account);
    this.persist(true);
    return account;
  }

  remove(id: string): boolean {
    const before = this.accounts.length;
    this.accounts = this.accounts.filter((account) => account.id !== id);
    if (this.accounts.length === before) return false;
    for (const [client, accountId] of this.sticky) if (accountId === id) this.sticky.delete(client);
    this.persist(true);
    return true;
  }

  reset(id: string): boolean {
    const account = this.find(id);
    if (!account) return false;
    account.healthScore = this.deps.scoring().healthRange.initial;
    account.consecutiveFailures = 0;
    account.modelScores = {};
    delete account.cooldowns;
    delete account.invalidatedAt;
    delete account.invalidReason;
    this.persist(true);
    this.deps.notify?.('cooldown', this.cooldowns());
    return true;
  }

  resetAll(): void {
    for (const account of this.accounts) {
      account.healthScore = this.deps.scoring().healthRange.initial;
      account.consecutiveFailures = 0;
      delete account.cooldowns;
    }
    this.persist(true);
    this.deps.notify?.('cooldown', this.cooldowns());
  }

  /** Write renewed tokens back. A refresh token the response omitted is kept. */
  storeTokens(id: string, tokens: KiroTokenSet): void {
    const account = this.find(id);
    if (!account) return;
    account.accessToken = tokens.accessToken;
    if (tokens.refreshToken) account.refreshToken = tokens.refreshToken;
    if (tokens.expiresIn) account.expiresAt = Date.now() + tokens.expiresIn * 1000;
    if (tokens.profileArn && !account.profileArn) account.profileArn = tokens.profileArn;
    delete account.invalidatedAt;
    delete account.invalidReason;
    this.persist(true);
  }

  setProfileArn(id: string, profileArn: string): void {
    const account = this.find(id);
    if (!account || account.profileArn === profileArn) return;
    account.profileArn = profileArn;
    this.persist(true);
  }

  invalidate(id: string, reason: string): void {
    const account = this.find(id);
    if (!account || account.invalidatedAt) return;
    account.invalidatedAt = Date.now();
    account.invalidReason = reason;
    account.healthScore = this.deps.scoring().healthRange.min;
    this.persist(true);
  }

  /**
   * Bench an account for a scope. An explicit duration (from `retry-after`) is honoured as given;
   * otherwise the configured default doubles with each consecutive failure, up to the maximum.
   */
  markCooldown(id: string, scope: string, durationMs?: number): boolean {
    const account = this.find(id);
    if (!account) return false;
    const { defaultDurationMs, maxDurationMs } = this.deps.rotation().cooldown;
    const backoff = Math.pow(2, Math.min(account.consecutiveFailures, 5));
    const ms = durationMs ?? Math.min(defaultDurationMs * backoff, maxDurationMs);
    account.cooldowns = { ...account.cooldowns, [scope]: Date.now() + ms };
    this.persist();
    this.deps.notify?.('cooldown', this.cooldowns());
    return true;
  }

  private cooldownUntil(account: KiroAccount, scope: string): number {
    return Math.max(account.cooldowns?.[scope] ?? 0, account.cooldowns?.[ACCOUNT_WIDE] ?? 0);
  }

  cooldowns(): Record<string, number> {
    const now = Date.now();
    const out: Record<string, number> = {};
    for (const account of this.accounts) {
      for (const [scope, until] of Object.entries(account.cooldowns ?? {})) {
        if (until > now) out[`${account.id}|${scope}`] = until;
      }
    }
    return out;
  }

  private priority(account: KiroAccount, now: number, modelId?: string): number {
    const { weights } = this.deps.scoring();
    const health = (modelId ? account.modelScores?.[modelId] : undefined) ?? account.healthScore;
    const idleSeconds = (now - account.lastUsed) / 1000;
    return health * weights.health + idleSeconds * weights.lru;
  }

  /**
   * The account to use next: not invalidated, not excluded, not cooling for this model. Ranked by
   * health (per model when known) and idleness, trimmed to the operator's multiplexing limit, with
   * a client kept on the account that last served it while that account is still eligible.
   */
  best(options: { modelId?: string; excludeIds?: string[]; clientId?: string } = {}): KiroAccount | null {
    const now = Date.now();
    const scope = cooldownScope(options.modelId);
    const exclude = options.excludeIds ?? [];
    const usable = this.accounts.filter(
      (account) => !account.invalidatedAt && !exclude.includes(account.id) && this.cooldownUntil(account, scope) <= now,
    );
    if (usable.length === 0) return null;

    if (options.clientId && exclude.length === 0) {
      const stickyId = this.sticky.get(options.clientId);
      const sticky = usable.find((account) => account.id === stickyId);
      if (sticky) return sticky;
    }

    if (this.strategy === 'round-robin') {
      const pool = capRotationPool(usable);
      this.cursor = (this.cursor + 1) % pool.length;
      return pool[this.cursor] ?? null;
    }

    const ranked = [...usable].sort((a, b) => {
      const diff = this.priority(b, now, options.modelId) - this.priority(a, now, options.modelId);
      return Math.abs(diff) < 0.1 ? a.lastUsed - b.lastUsed : diff;
    });
    return capRotationPool(ranked)[0] ?? null;
  }

  /** Score one request's outcome against the account (and the model, when known). */
  recordResult(id: string, success: boolean, meta: { modelId?: string; status?: number; clientId?: string } = {}): void {
    const account = this.find(id);
    if (!account) return;
    const scoring = this.deps.scoring();
    const delta = success
      ? scoring.rewards.success
      : meta.status === 401 || meta.status === 403
        ? scoring.penalties.fatalError
        : scoring.penalties.apiError;
    const clamp = (value: number) => Math.max(scoring.healthRange.min, Math.min(scoring.healthRange.max, value));

    account.lastUsed = Date.now();
    account.healthScore = clamp(account.healthScore + delta);
    if (meta.modelId) {
      account.modelScores = {
        ...account.modelScores,
        [meta.modelId]: clamp((account.modelScores?.[meta.modelId] ?? scoring.healthRange.initial) + delta),
      };
    }

    if (success) {
      account.consecutiveFailures = 0;
      if (meta.clientId) this.sticky.set(meta.clientId, id);
      if (meta.modelId && account.cooldowns?.[cooldownScope(meta.modelId)]) {
        const { [cooldownScope(meta.modelId)]: _cleared, ...rest } = account.cooldowns;
        account.cooldowns = rest;
      }
    } else {
      account.consecutiveFailures += 1;
    }
    this.persist();
  }
}

export const kiroAccounts = new KiroAccountPool({
  persist: (data, immediate) => saveAccountsFile(data, { immediate }),
  scoring: () => getProxyConfig().scoring,
  rotation: () => getProxyConfig().rotation,
  notify: (event, payload) => adminEventBus.emit(event, payload),
});

export async function initKiroAccounts(): Promise<void> {
  kiroAccounts.load(await loadAccountsFile());
  console.log(`[kiro] loaded ${kiroAccounts.list().length} account(s)`);
}
