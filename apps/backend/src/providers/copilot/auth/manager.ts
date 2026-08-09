import { getProxyConfig as getGlobalProxyConfig } from '@/config/manager';
import { adminEventBus } from '@/core/events';
import type { UpstreamErrorKind } from '@/core/upstream-errors';
import { ensureSessionToken, TokenExchangeError } from './token-exchange';
import { loadConfig, saveConfig, type SelectionStrategy } from './storage';
import { type CopilotAccount } from './types';

let accounts: CopilotAccount[] = [];
let currentStrategy: SelectionStrategy = 'hybrid';
const clientStickyMap = new Map<string, string>();
const cooldownMap = new Map<string, number>();
/** Why each cooldown was applied, for the dashboard and the logs. */
const cooldownReasons = new Map<string, UpstreamErrorKind>();

// How long an account stays out of rotation after being marked 'invalid' before
// it is re-probed (half-open). Keeps a genuinely-dead token from hot-looping
// while ensuring a transiently-failed account heals itself automatically.
const INVALID_PROBE_WINDOW_MS = 5 * 60 * 1000;

const MODEL_FAMILIES = {
  'GPT': (n: string) => n.includes('gpt') || n.includes('o3') || n.includes('o4'),
  'Claude': (n: string) => n.includes('claude') || n.includes('sonnet'),
  'Gemini': (n: string) => n.includes('gemini'),
};

/**
 * The scope a cooldown applies to — see the Antigravity manager for the full
 * reasoning. Kept identical here on purpose: both providers cool down per
 * *model*, with `ACCOUNT_WIDE` for "this whole account is out".
 */
export const ACCOUNT_WIDE = '*';

export function cooldownScope(model?: string): string {
  return model ? model.trim().toLowerCase() : ACCOUNT_WIDE;
}

/** The later of this account's model-scoped and account-wide locks. */
function cooldownExpiry(id: string, pool: string, model?: string): number {
  const scoped = cooldownMap.get(`${id}|${pool}|${cooldownScope(model)}`) ?? 0;
  const accountWide = cooldownMap.get(`${id}|${pool}|${ACCOUNT_WIDE}`) ?? 0;
  return Math.max(scoped, accountWide);
}

export function getFamilyName(modelName: string): string {
  const n = modelName.toLowerCase();
  for (const [family, check] of Object.entries(MODEL_FAMILIES)) {
    if (check(n)) return family;
  }
  return 'Other';
}

function getManagerConfig() {
  try {
    return getGlobalProxyConfig();
  } catch {
    return {
      rotation: { cooldown: { defaultDurationMs: 60000, maxDurationMs: 3600000 } },
      scoring: {
        weights: { health: 2, lru: 0.1 },
        healthRange: { min: 0, max: 100, initial: 100 },
        penalties: { apiError: -10, refreshError: -20, fatalError: -50, systemicError: -10 },
        rewards: { success: 2 },
      },
      tokens: { expiryBufferMs: 60000 },
    };
  }
}

export async function initManager() {
  const config = await loadConfig();
  accounts = config.accounts || [];
  currentStrategy = config.strategy || 'hybrid';
  console.log(`[Copilot Manager] Loaded ${accounts.length} accounts from storage.`);
}

export function getAccounts() {
  return accounts;
}

export function getStrategy() {
  return currentStrategy;
}

export function setStrategy(strategy: SelectionStrategy) {
  currentStrategy = strategy;
  saveAccounts(accounts);
}

/**
 * Persist accounts. Routine saves are coalesced by the storage layer; pass
 * `immediate` when credentials changed, so a restart can never lose them.
 */
export async function saveAccounts(
  newAccounts: CopilotAccount[],
  options: { immediate?: boolean } = {},
) {
  accounts = newAccounts;
  await saveConfig({ accounts, strategy: currentStrategy }, options);
  adminEventBus.emit("update", { accounts, strategy: currentStrategy });
}

export function getCooldowns(): Record<string, number> {
  return Object.fromEntries(cooldownMap);
}

export function markCooldown(
  id: string,
  pool: "cli" | "sandbox",
  scope: string,
  duration?: string,
  reason: UpstreamErrorKind = 'rate_limited',
) {
  const config = getManagerConfig();
  const account = accounts.find(a => a.id === id);
  const key = `${id}|${pool}|${scope}`;
  let baseDuration = config.rotation.cooldown.defaultDurationMs;

  if (duration) {
    if (duration === "0s") return;
    baseDuration = parseDuration(duration);
  }

  const consecutive = account?.consecutiveFailures || 0;
  const backoffMultiplier = Math.pow(2, Math.min(consecutive, 5));
  const expiry = Date.now() + Math.min(baseDuration * backoffMultiplier, config.rotation.cooldown.maxDurationMs);

  cooldownMap.set(key, expiry);
  cooldownReasons.set(key, reason);
  if (account) {
    if (!account.cooldowns) account.cooldowns = {};
    account.cooldowns[`${pool}|${scope}`] = expiry;
    account.consecutiveFailures = (account.consecutiveFailures || 0) + 1;
    account.status = 'cooldown';
    saveAccounts(accounts);
  }
  adminEventBus.emit("cooldown", { cooldowns: Object.fromEntries(cooldownMap) });
}

export function clearCooldown(id: string, pool: string, scope: string) {
  const key = `${id}|${pool}|${scope}`;
  if (cooldownMap.has(key)) {
    cooldownMap.delete(key);
    cooldownReasons.delete(key);
    const account = accounts.find(a => a.id === id);
    if (account && account.cooldowns) {
      delete account.cooldowns[`${pool}|${scope}`];
      account.consecutiveFailures = 0;
      account.status = 'active';
      saveAccounts(accounts);
    }
    adminEventBus.emit("cooldown", { cooldowns: Object.fromEntries(cooldownMap) });
  }
}

export function resetAllCooldowns() {
  cooldownMap.clear();
  for (const account of accounts) {
    account.cooldowns = {};
    account.consecutiveFailures = 0;
    account.status = 'active';
  }
  saveAccounts(accounts);
}

export async function getBestAccount(
  pool?: "cli" | "sandbox",
  model?: string,
  clientId?: string,
  excludeIds: string[] = [],
  skipRescue: boolean = false
): Promise<CopilotAccount | null> {
  if (accounts.length === 0) return null;
  const now = Date.now();
  
  // Filter active/usable accounts. Invalid accounts are normally excluded, but
  // become eligible again as a "half-open" probe once the recovery window has
  // elapsed, so a transient outage never bricks an account permanently.
  const usable = accounts.filter(a => {
    if (!a.personalToken || excludeIds.includes(a.id)) return false;
    if (a.status === 'invalid') {
      // Legacy invalid accounts (no invalidatedAt) are probed immediately.
      return a.invalidatedAt === undefined || (now - a.invalidatedAt) >= INVALID_PROBE_WINDOW_MS;
    }
    return true;
  });
  if (pool) {
    let candidates = usable.filter(a => {
      if (model && a.capabilities?.[model] === false) return false;
      // Read with the same scope the executor writes. These used to disagree —
      // written as the model id, read as the family — so a 429 cooldown was
      // never seen and the account was picked again immediately.
      return cooldownExpiry(a.id, pool, model) <= now;
    });

    if (candidates.length === 0 && !skipRescue) {
      candidates = usable.filter(a => !(model && a.capabilities?.[model] === false))
        .filter(a => {
          return cooldownExpiry(a.id, pool, model) <= now + 300000; // 5 min rescue window
        })
        .sort((a, b) => {
          const expA = cooldownExpiry(a.id, pool, model);
          const expB = cooldownExpiry(b.id, pool, model);
          return expA - expB;
        });
    }

    if (candidates.length === 0) return null;

    if (clientId && excludeIds.length === 0) {
      const stickyId = clientStickyMap.get(clientId);
      const sticky = candidates.find(a => a.id === stickyId && cooldownExpiry(a.id, pool, model) <= now);
      if (sticky) return await ensureAccountReady(sticky);
    }

    candidates.sort((a, b) => {
      const priorityB = calculatePriority(b, now, model, pool);
      const priorityA = calculatePriority(a, now, model, pool);
      if (Math.abs(priorityA - priorityB) < 0.1) {
        return a.lastUsed - b.lastUsed;
      }
      return priorityB - priorityA;
    });

    // Simple offset to vary selection across multiple parallel requests
    const offset = process.pid % Math.max(candidates.length, 1);
    const selectedIndex = offset % candidates.length;

    return await ensureAccountReady(candidates[selectedIndex]);
  }
  return null;
}

async function ensureAccountReady(account: CopilotAccount): Promise<CopilotAccount | null> {
  try {
    await ensureSessionToken(account);
    // Successful exchange: recover the account if it had been marked invalid
    // (e.g. by a previous transient outage or an expired token that's now fresh).
    if (account.status === 'invalid') {
      console.log(`[Copilot Manager] Account ${account.id} recovered after successful token exchange.`);
      account.status = 'active';
      account.invalidatedAt = undefined;
      account.healthScore = Math.max(account.healthScore, 50);
    }
    await saveAccounts(accounts);
    return account;
  } catch (e: any) {
    const status: number | undefined = e instanceof TokenExchangeError ? e.status : undefined;
    const isAuthFailure = status === 401 || status === 403;

    if (isAuthFailure) {
      // Token is genuinely bad (revoked/expired/no Copilot entitlement): only a
      // re-login can fix it. Mark invalid, but stamp the time so it can still be
      // re-probed later instead of staying dead forever.
      console.error(`[Copilot Manager] Auth failure (${status}) exchanging token for ${account.id}. Marking invalid.`, e);
      account.healthScore = Math.max(0, account.healthScore - 20);
      account.status = 'invalid';
      account.invalidatedAt = Date.now();
    } else {
      // Transient failure (network/timeout/5xx, e.g. GitHub's 502 "Unicorn").
      // Do NOT brick the account — a single upstream hiccup must not take it out.
      console.warn(`[Copilot Manager] Transient error exchanging token for ${account.id} (status=${status ?? 'network'}). Keeping account, will retry.`, e);
      account.healthScore = Math.max(0, account.healthScore - 5);
    }
    await saveAccounts(accounts);
    return null;
  }
}

function calculatePriority(account: CopilotAccount, now: number, model?: string, pool?: string): number {
  const config = getManagerConfig();
  const secondsSinceUsed = (now - account.lastUsed) / 1000;
  let health = account.healthScore;

  if (model && pool) {
    const score = account.modelScores?.[`${model}|${pool}`];
    if (score !== undefined) health = score;
  }

  return (health * config.scoring.weights.health) + (secondsSinceUsed * config.scoring.weights.lru);
}

export async function updateAccountUsage(
  id: string,
  success: boolean,
  model?: string,
  pool?: string,
  clientId?: string,
  status?: number
) {
  const account = accounts.find(a => a.id === id);
  if (!account) return;

  if (success && clientId) clientStickyMap.set(clientId, id);
  if (success && pool && model) clearCooldown(id, pool, cooldownScope(model));

  account.lastUsed = Date.now();
  const delta = success ? 2 : (status === 401 || status === 403 ? -50 : -10);
  account.healthScore = Math.max(0, Math.min(100, account.healthScore + delta));

  if (model && pool) {
    if (!account.modelScores) account.modelScores = {};
    const key = `${model}|${pool}`;
    account.modelScores[key] = Math.max(0, Math.min(100, (account.modelScores[key] ?? 100) + delta));
  }

  if (status === 401) {
    account.status = 'invalid';
    account.invalidatedAt = Date.now();
  }

  await saveAccounts(accounts);
}

export function parseDuration(val: string): number {
  const match = val.match(/^(\d+)([smh])$/);
  if (!match) return 60000;
  const amount = parseInt(match[1]);
  const multipliers: Record<string, number> = { s: 1000, m: 60000, h: 3600000 };
  return amount * multipliers[match[2]];
}

export function flagModelUnsupported(id: string, model: string) {
  const account = accounts.find(a => a.id === id);
  if (account) {
    if (!account.capabilities) account.capabilities = {};
    account.capabilities[model] = false;
    saveAccounts(accounts);
  }
}

export async function resetAccount(id: string) {
  const account = accounts.find(a => a.id === id);
  if (account) {
    account.healthScore = 100;
    account.consecutiveFailures = 0;
    account.cooldowns = {};
    account.modelScores = {};
    account.status = 'active';
    account.invalidatedAt = undefined;
    // Selection honours capabilities[model] === false, and nothing else clears
    // it — the same trap that made Antigravity's flag permanent. Reset is the
    // way back.
    account.capabilities = {};

    const keysToDelete = [];
    for (const [key] of cooldownMap) {
      if (key.startsWith(id + "|")) keysToDelete.push(key);
    }
    for (const key of keysToDelete) cooldownMap.delete(key);
    await saveAccounts(accounts);
  }
}

export async function addAccount(account: CopilotAccount) {
  const existing = accounts.find(a => a.id === account.id);
  if (existing) {
    Object.assign(existing, account);
  } else {
    accounts.push(account);
  }
  await saveAccounts(accounts, { immediate: true });
}

export async function removeAccount(id: string) {
  accounts = accounts.filter(a => a.id !== id);
  await saveAccounts(accounts, { immediate: true });
}

export function getEarliestReset(_pool: "cli" | "sandbox"): string | null {
  // Copilot doesn't expose a structured quota reset time API similar to Vertex
  return null;
}
