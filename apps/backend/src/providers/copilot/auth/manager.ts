import { getProxyConfig as getGlobalProxyConfig } from '@/config/manager';
import { adminEventBus } from '@/core/events';
import { ensureSessionToken } from './token-exchange';
import { loadConfig, saveConfig, type SelectionStrategy } from './storage';
import { type CopilotAccount } from './types';

let accounts: CopilotAccount[] = [];
let currentStrategy: SelectionStrategy = 'hybrid';
const clientStickyMap = new Map<string, string>();
const cooldownMap = new Map<string, number>();

const MODEL_FAMILIES = {
  'GPT': (n: string) => n.includes('gpt') || n.includes('o3') || n.includes('o4'),
  'Claude': (n: string) => n.includes('claude') || n.includes('sonnet'),
  'Gemini': (n: string) => n.includes('gemini'),
};

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

export async function saveAccounts(newAccounts: CopilotAccount[]) {
  accounts = newAccounts;
  await saveConfig({ accounts, strategy: currentStrategy });
  adminEventBus.emit("update", { accounts, strategy: currentStrategy });
}

export function getCooldowns(): Record<string, number> {
  return Object.fromEntries(cooldownMap);
}

export function markCooldown(id: string, pool: "cli" | "sandbox", modelFamily: string, duration?: string) {
  const config = getManagerConfig();
  const account = accounts.find(a => a.id === id);
  const key = `${id}|${pool}|${modelFamily}`;
  let baseDuration = config.rotation.cooldown.defaultDurationMs;

  if (duration) {
    if (duration === "0s") return;
    baseDuration = parseDuration(duration);
  }

  const consecutive = account?.consecutiveFailures || 0;
  const backoffMultiplier = Math.pow(2, Math.min(consecutive, 5));
  const expiry = Date.now() + Math.min(baseDuration * backoffMultiplier, config.rotation.cooldown.maxDurationMs);

  cooldownMap.set(key, expiry);
  if (account) {
    if (!account.cooldowns) account.cooldowns = {};
    account.cooldowns[`${pool}|${modelFamily}`] = expiry;
    account.consecutiveFailures = (account.consecutiveFailures || 0) + 1;
    account.status = 'cooldown';
    saveAccounts(accounts);
  }
  adminEventBus.emit("cooldown", { cooldowns: Object.fromEntries(cooldownMap) });
}

export function clearCooldown(id: string, pool: string, modelFamily: string) {
  const key = `${id}|${pool}|${modelFamily}`;
  if (cooldownMap.has(key)) {
    cooldownMap.delete(key);
    const account = accounts.find(a => a.id === id);
    if (account && account.cooldowns) {
      delete account.cooldowns[`${pool}|${modelFamily}`];
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
  
  // Filter active/usable accounts
  const usable = accounts.filter(a => a.personalToken && a.status !== 'invalid' && !excludeIds.includes(a.id));
  const family = model ? getFamilyName(model) : "Other";

  if (pool) {
    let candidates = usable.filter(a => {
      if (model && a.capabilities?.[model] === false) return false;
      const expiry = cooldownMap.get(`${a.id}|${pool}|${family}`);
      return !expiry || expiry <= now;
    });

    if (candidates.length === 0 && !skipRescue) {
      candidates = usable.filter(a => !(model && a.capabilities?.[model] === false))
        .filter(a => {
          const expiry = cooldownMap.get(`${a.id}|${pool}|${family}`);
          return !expiry || expiry <= now + 300000; // 5 min rescue window
        })
        .sort((a, b) => {
          const expA = cooldownMap.get(`${a.id}|${pool}|${family}`) || 0;
          const expB = cooldownMap.get(`${b.id}|${pool}|${family}`) || 0;
          return expA - expB;
        });
    }

    if (candidates.length === 0) return null;

    if (clientId && excludeIds.length === 0) {
      const stickyId = clientStickyMap.get(clientId);
      const sticky = candidates.find(a => a.id === stickyId && !cooldownMap.has(`${a.id}|${pool}|${family}`));
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
    await saveAccounts(accounts);
    return account;
  } catch (e) {
    console.error(`[Copilot Manager] Failed to exchange session token for ${account.id}:`, e);
    account.healthScore = Math.max(0, account.healthScore - 20);
    account.status = 'invalid';
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
  if (success && pool && model) clearCooldown(id, pool, getFamilyName(model));

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
  await saveAccounts(accounts);
}

export async function removeAccount(id: string) {
  accounts = accounts.filter(a => a.id !== id);
  await saveAccounts(accounts);
}

export function getEarliestReset(_pool: "cli" | "sandbox"): string | null {
  // Copilot doesn't expose a structured quota reset time API similar to Vertex
  return null;
}
