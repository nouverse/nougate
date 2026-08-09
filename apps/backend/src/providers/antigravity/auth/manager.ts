import { getProxyConfig as getGlobalProxyConfig } from '@/config/manager';
import { adminEventBus } from '@/core/events';
import type { UpstreamErrorKind } from '@/core/upstream-errors';
import { getAntigravityConfig, loadAntigravityConfig } from '@/providers/antigravity/provider-config';
import { generateFingerprint } from '@/providers/antigravity/upstream/headers';
import { getProjectId, refreshAccessToken } from '@/providers/antigravity/auth/oauth';
import { loadConfig, saveConfig } from '@/providers/antigravity/auth/storage';
import { type AntigravityAccount, type SelectionStrategy } from '@/providers/antigravity/auth/types';

let accounts: AntigravityAccount[] = [];
let currentStrategy: SelectionStrategy = 'hybrid';
const clientStickyMap = new Map<string, string>();
const cooldownMap = new Map<string, number>();
/** Why each cooldown was applied, for the dashboard and the logs. */
const cooldownReasons = new Map<string, UpstreamErrorKind>();

const MODEL_FAMILIES = {
  'Gemini 3 Flash': (n: string) =>
    n.includes('gemini') && (n.includes('flash') || n.includes('1.5 flash')) && !n.includes('2.5'),
  'Gemini 3 Pro': (n: string) =>
    ((n.includes('gemini') && (n.includes('pro') || n.includes('1.5 pro'))) || n.includes('image')) &&
    !n.includes('2.5'),
  'Gemini 2.5': (n: string) => n.includes('2.5'),
  'Claude/GPT': (n: string) => n.includes('claude') || n.includes('gpt'),
};

/**
 * Group a model into the legacy quota/cooldown family buckets.
 */
/**
 * The scope a cooldown applies to.
 *
 * Rate limits are per *model*, not per family: a limit on gemini-3-pro must not
 * take gemini-3-flash out of rotation with it, which is exactly what keying on
 * the family did. `ACCOUNT_WIDE` is the separate scope for "this whole account
 * is out" — a manual cooldown, or an auth failure — and every check honours
 * both, so a model lock and an account lock cannot mask each other.
 */
export const ACCOUNT_WIDE = '*';

export function cooldownScope(model?: string): string {
  return model ? model.trim().toLowerCase() : ACCOUNT_WIDE;
}

/**
 * How long this account must wait before it can serve `model` again.
 *
 * Returns the later of the model-scoped lock and the account-wide lock.
 */
function cooldownExpiry(email: string, pool: string, model?: string): number {
  const scoped = cooldownMap.get(`${email}|${pool}|${cooldownScope(model)}`) ?? 0;
  const accountWide = cooldownMap.get(`${email}|${pool}|${ACCOUNT_WIDE}`) ?? 0;
  return Math.max(scoped, accountWide);
}

export function getFamilyName(modelName: string) {
  const n = modelName.toLowerCase();
  for (const [family, check] of Object.entries(MODEL_FAMILIES)) {
    if (check(n)) return family;
  }
  return 'Other';
}

/**
 * Read both global proxy config and provider-local config with safe fallbacks.
 */
function getManagerConfig() {
  const globalConfig = (() => {
    try {
      return getGlobalProxyConfig();
    } catch {
      return {
        rotation: { cooldown: { defaultDurationMs: 60000, maxDurationMs: 3600000 } },
        scoring: {
          weights: { health: 2, lru: 0.1, quota: 25 },
          healthRange: { min: 0, max: 100, initial: 100 },
          penalties: { apiError: -10, refreshError: -20, fatalError: -50, systemicError: -10 },
          rewards: { success: 2 },
        },
        tokens: { expiryBufferMs: 60000 },
      };
    }
  })();

  const providerConfig = (() => {
    try {
      return getAntigravityConfig();
    } catch {
      return {
        features: {
          pidOffsetEnabled: false,
          softQuotaThresholdPercent: 90,
        },
        scheduling: {
          mode: 'cache_first',
          maxCacheFirstWaitSeconds: 60,
          maxRateLimitWaitSeconds: 300,
        },
      };
    }
  })();

  return {
    ...globalConfig,
    features: providerConfig.features,
    scheduling: providerConfig.scheduling,
  };
}

/**
 * Normalize stored model-related keys from the old `antigravity-` prefix format.
 */
function normalizeStoredModelKey(key: string): string {
  const [modelKey, suffix] = key.split('|');
  const normalizedModelKey = modelKey.replace(/^antigravity[-:]/, '');
  return suffix ? `${normalizedModelKey}|${suffix}` : normalizedModelKey;
}

/**
 * Migrate per-account model metadata to the provider-local key format.
 */
function migrateAccountModelMetadata(account: AntigravityAccount): boolean {
  let changed = false;

  if (account.modelScores) {
    const migratedScores: Record<string, number> = {};
    for (const [key, value] of Object.entries(account.modelScores)) {
      const normalizedKey = normalizeStoredModelKey(key);
      migratedScores[normalizedKey] = value;
      changed = changed || normalizedKey !== key;
    }
    account.modelScores = migratedScores;
  }

  if (account.capabilities) {
    const migratedCapabilities: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(account.capabilities)) {
      const normalizedKey = normalizeStoredModelKey(key);
      migratedCapabilities[normalizedKey] = value;
      changed = changed || normalizedKey !== key;
    }
    account.capabilities = migratedCapabilities;
  }

  return changed;
}

/**
 * Load account state and apply startup migrations for legacy metadata keys.
 */
export async function initManager() {
  await loadAntigravityConfig();
  const config = await loadConfig();
  accounts = config.accounts || [];
  currentStrategy = config.strategy || 'hybrid';

  let migrated = false;
  for (const account of accounts) {
    migrated = migrateAccountModelMetadata(account) || migrated;
  }

  if (migrated) {
    await saveConfig({ accounts, strategy: currentStrategy });
    console.log('[Manager] Migrated legacy antigravity-prefixed account metadata.');
  }

  console.log(`[Manager] Loaded ${accounts.length} accounts from storage.`);
}

export function getAccounts() { return accounts; }
export function getStrategy() { return currentStrategy; }
export function setStrategy(strategy: SelectionStrategy) {
  currentStrategy = strategy;
  saveAccounts(accounts);
}

/**
 * Persist accounts. Routine saves are coalesced by the storage layer; pass
 * `immediate` when credentials changed, so a restart can never lose them.
 */
export async function saveAccounts(
  newAccounts: AntigravityAccount[],
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
  email: string,
  pool: "cli" | "sandbox",
  scope: string,
  resetTimeStr?: string,
  reason: UpstreamErrorKind = 'rate_limited',
) {
  const config = getManagerConfig();
  const account = accounts.find(a => a.email === email);
  const key = `${email}|${pool}|${scope}`;
  let baseDuration = config.rotation.cooldown.defaultDurationMs;

  if (resetTimeStr) {
    if (resetTimeStr === "0s") return;
    baseDuration = parseDuration(resetTimeStr);
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
    saveAccounts(accounts);
  }
  adminEventBus.emit("cooldown", { cooldowns: Object.fromEntries(cooldownMap) });
}

export function clearCooldown(email: string, pool: string, scope: string) {
  const key = `${email}|${pool}|${scope}`;
  if (cooldownMap.has(key)) {
    cooldownMap.delete(key);
    cooldownReasons.delete(key);
    const account = accounts.find(a => a.email === email);
    if (account && account.cooldowns) {
      delete account.cooldowns[`${pool}|${scope}`];
      account.consecutiveFailures = 0;
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
  }
  saveAccounts(accounts);
}

export function flagAccountChallenge(email: string, pool: "cli" | "sandbox", modelFamily: string, challenge: any) {
  const account = accounts.find(a => a.email === email);
  if (account) {
    const expiry = Date.now() + 3600000;
    const key = `${email}|${pool}|${modelFamily}`;
    cooldownMap.set(key, expiry);
    if (!account.cooldowns) account.cooldowns = {};
    account.cooldowns[`${pool}|${modelFamily}`] = expiry;
    account.challenge = { ...challenge, detectedAt: Date.now() };
    saveAccounts(accounts);
    adminEventBus.emit("cooldown", { cooldowns: Object.fromEntries(cooldownMap) });
  }
}

/**
 * The quota entries that describe the model being asked for.
 *
 * Antigravity names its quota groups loosely ("Claude Sonnet 4.6", "Gemini 3
 * Pro"), so matching is on the family name with a couple of explicit vendor
 * fallbacks. With no model given, every quota is relevant.
 */
function relevantQuotasFor(account: AntigravityAccount, model?: string) {
  if (!account.quota || account.quota.length === 0) {
    return [];
  }

  const family = model ? getFamilyName(model) : null;
  if (!family) {
    return account.quota;
  }

  const fLower = family.toLowerCase();
  return account.quota.filter(q => {
    const qLower = q.groupName.toLowerCase();
    return qLower.includes(fLower) || fLower.includes(qLower) ||
      (fLower.includes("claude") && qLower.includes("claude")) ||
      (fLower.includes("gemini") && qLower.includes("gemini"));
  });
}

/**
 * How much headroom this account has left for `model`, 0–1.
 *
 * `null` means the provider has told us nothing — a brand-new account, or one
 * whose quota poll has not landed yet. Callers must treat that as "no opinion"
 * rather than as empty, or adding an account would make the pool look
 * exhausted.
 *
 * The *worst* relevant quota wins: an account that is fine on one limit and out
 * on another cannot serve the request.
 */
export function remainingQuotaFraction(account: AntigravityAccount, model?: string): number | null {
  const relevant = relevantQuotasFor(account, model);
  if (relevant.length === 0) {
    return null;
  }

  return relevant.reduce(
    (worst, q) => Math.min(worst, Math.max(0, Math.min(1, q.remainingFraction))),
    1,
  );
}

function isAccountQuotaExhausted(account: AntigravityAccount, model?: string): boolean {
  let config: ReturnType<typeof getManagerConfig>;
  try { config = getManagerConfig(); } catch { return false; }
  const threshold = config.features.softQuotaThresholdPercent;
  if (threshold >= 100 || !account.quota || account.quota.length === 0) return false;

  const relevantQuotas = relevantQuotasFor(account, model);
  if (relevantQuotas.length === 0) return false;

  const family = model ? getFamilyName(model) : null;
  const usedPercent = relevantQuotas.reduce((worst, q) => {
    const used = (1 - q.remainingFraction) * 100;
    return Math.max(worst, used);
  }, 0);

  if (usedPercent >= threshold) {
    console.log(`[SoftQuota] Skipping ${account.email} for ${family || "unknown"}: ${usedPercent.toFixed(1)}% used (threshold: ${threshold}%)`);
    return true;
  }
  return false;
}

function getPidOffset(): number {
  let config: ReturnType<typeof getManagerConfig>;
  try { config = getManagerConfig(); } catch { return 0; }
  if (!config.features.pidOffsetEnabled) return 0;
  return process.pid % Math.max(accounts.length, 1);
}

export async function getBestAccount(pool?: "cli" | "sandbox", model?: string, clientId?: string, excludeEmails: string[] = [], skipRescue: boolean = false): Promise<AntigravityAccount | null> {
  if (accounts.length === 0) return null;
  const now = Date.now();
  const usable = accounts.filter(a => a.refreshToken && !a.challenge && !excludeEmails.includes(a.email));
  if (pool) {
    let candidates = usable.filter(a => {
      if (isModelUnsupportedFor(a, model)) return false;
      if (isAccountQuotaExhausted(a, model)) return false;
      const expiry = cooldownExpiry(a.email, pool, model);
      return !expiry || expiry <= now;
    });

    let schedulingConfig: ReturnType<typeof getManagerConfig>["scheduling"] | undefined;
    try { schedulingConfig = getManagerConfig().scheduling; } catch {}

    if (candidates.length === 0 && schedulingConfig?.mode === "cache_first" && clientId) {
      const stickyEmail = clientStickyMap.get(clientId);
      if (stickyEmail && !excludeEmails.includes(stickyEmail)) {
        const stickyAccount = usable.find(a => a.email === stickyEmail);
        if (stickyAccount) {
          const expiry = cooldownExpiry(stickyEmail, pool, model);
          if (expiry && expiry > now) {
            const waitMs = expiry - now;
            const maxWaitMs = (schedulingConfig.maxCacheFirstWaitSeconds || 60) * 1000;
            if (waitMs <= maxWaitMs) {
              console.log(`[CacheFirst] Waiting ${Math.ceil(waitMs / 1000)}s for ${stickyEmail} to preserve prompt cache...`);
              await new Promise(r => setTimeout(r, waitMs));
              const ready = await ensureAccountReady(stickyAccount);
              if (ready) return ready;
              // Its token would not refresh; fall through to the normal pool
              // rather than failing a request other accounts could serve.
            }
            console.log(`[CacheFirst] ${stickyEmail} cooldown (${Math.ceil(waitMs / 1000)}s) exceeds max wait (${schedulingConfig.maxCacheFirstWaitSeconds}s), switching account.`);
          }
        }
      }
    }

    if (candidates.length === 0 && !skipRescue) {
      candidates = usable.filter(a => !isModelUnsupportedFor(a, model))
        .filter(a => {
          const expiry = cooldownExpiry(a.email, pool, model);
          return !expiry || expiry <= now + 300000;
        })
        .sort((a, b) => {
          const expA = cooldownExpiry(a.email, pool, model);
          const expB = cooldownExpiry(b.email, pool, model);
          return expA - expB;
        });
    }

    if (candidates.length === 0) return null;

    if (clientId && excludeEmails.length === 0) {
      const stickyEmail = clientStickyMap.get(clientId);
      const sticky = candidates.find(a => a.email === stickyEmail && cooldownExpiry(a.email, pool, model) <= now);
      if (sticky) {
        const ready = await ensureAccountReady(sticky);
        if (ready) return ready;
      }
    }

    candidates.sort((a, b) => {
      const priorityB = calculatePriority(b, now, model, pool);
      const priorityA = calculatePriority(a, now, model, pool);
      if (Math.abs(priorityA - priorityB) < 0.1) {
        return a.lastUsed - b.lastUsed;
      }
      return priorityB - priorityA;
    });

    const offset = getPidOffset();

    // Walk the ranked list until one is actually ready.
    //
    // A token that will not refresh used to end the whole selection: the caller
    // got null, the account was never recorded as tried, and the next attempt
    // picked the same broken account again — burning every retry, with a token
    // round trip and a backoff sleep each time, while healthy accounts idled.
    for (let step = 0; step < candidates.length; step += 1) {
      const candidate = candidates[(offset + step) % candidates.length];
      const ready = await ensureAccountReady(candidate);
      if (ready) {
        return ready;
      }
      console.warn(`[Rotation] ${candidate.email} could not be made ready; trying the next account.`);
    }

    return null;
  }
  return null;
}

async function ensureAccountReady(account: AntigravityAccount): Promise<AntigravityAccount | null> {
  const now = Date.now();
  const config = getManagerConfig();
  const needsRefresh = !account.accessToken || (account.expiresAt && account.expiresAt < now + config.tokens.expiryBufferMs);

  if (needsRefresh) {
    try {
      const tokens = await refreshAccessToken(account.refreshToken);
      account.accessToken = tokens.access_token;
      account.expiresAt = now + (tokens.expires_in * 1000);
      if (!account.projectId) account.projectId = await getProjectId(account.accessToken) || "rising-fact-p41fc";
      await saveAccounts(accounts, { immediate: true });
    } catch (e) {
      account.healthScore = Math.max(0, account.healthScore - 20);
      await saveAccounts(accounts);
      return null;
    }
  }
  return account;
}

function calculatePriority(account: AntigravityAccount, now: number, model?: string, pool?: string): number {
  const config = getManagerConfig();
  const secondsSinceUsed = (now - account.lastUsed) / 1000;
  let health = account.healthScore;
  if (model && pool) {
    const family = getFamilyName(model);
    let score = account.modelScores?.[`${model}|${pool}`];

    if (score === undefined && account.modelScores) {
      let sum = 0;
      let count = 0;
      Object.entries(account.modelScores).forEach(([key, val]) => {
        if (key.endsWith(`|${pool}`) && getFamilyName(key.split("|")[0]) === family) {
          sum += val;
          count++;
        }
      });
      if (count > 0) score = sum / count;
    }

    if (score !== undefined) health = score;
  }

  // Tier bonus: ultra gets +30, pro gets +15, free gets +0
  const tierBonus = account.tier === 'ultra' ? 30 : account.tier === 'pro' ? 15 : 0;

  // Remaining quota, when the provider reports it. Health is reactive — it only
  // drops after a request has already failed — so ranking on quota as well lets
  // a nearly-spent account be passed over before it wastes an attempt.
  //
  // No quota data scores 0, which is exactly the ranking these accounts had
  // before this dimension existed.
  const remaining = remainingQuotaFraction(account, model);
  const quotaBonus = remaining === null ? 0 : remaining * (config.scoring.weights.quota ?? 0);

  return (health * config.scoring.weights.health)
    + (secondsSinceUsed * config.scoring.weights.lru)
    + tierBonus
    + quotaBonus;
}

export async function updateAccountUsage(email: string, success: boolean, model?: string, pool?: string, clientId?: string, status?: number) {
  const account = accounts.find(a => a.email === email);
  if (!account) return;
  if (success && clientId) clientStickyMap.set(clientId, email);
  if (success && pool && model) clearCooldown(email, pool, cooldownScope(model));
  account.lastUsed = Date.now();
  const delta = success ? 2 : (status === 403 ? -50 : -10);
  account.healthScore = Math.max(0, Math.min(100, account.healthScore + delta));
  if (model && pool) {
    if (!account.modelScores) account.modelScores = {};
    const key = `${model}|${pool}`;
    account.modelScores[key] = Math.max(0, Math.min(100, (account.modelScores[key] ?? 100) + delta));
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

/**
 * How long a "this account cannot serve this model" flag is trusted.
 *
 * The flag comes from a single 404/403 reply, and Antigravity rolls models out
 * to accounts at different times — so today's "not found" is often tomorrow's
 * supported model. The flag used to be permanent and nothing cleared it, not
 * even the dashboard's Reset button, so one transient 404 removed an account
 * from a model for good and the pool quietly shrank. Expiring it means a wrong
 * flag costs one probe every six hours instead of forever.
 */
const UNSUPPORTED_PROBE_WINDOW_MS = 6 * 60 * 60 * 1000;

export function isModelUnsupportedFor(account: AntigravityAccount, model?: string): boolean {
  if (!model || account.capabilities?.[model] !== false) {
    return false;
  }

  const flaggedAt = account.capabilityFlaggedAt?.[model];
  // A flag with no timestamp predates expiry; re-probe it once rather than
  // honouring it forever.
  if (!flaggedAt) {
    return false;
  }

  return Date.now() - flaggedAt < UNSUPPORTED_PROBE_WINDOW_MS;
}

export function flagModelUnsupported(email: string, model: string) {
  const account = accounts.find(a => a.email === email);
  if (account) {
    if (!account.capabilities) account.capabilities = {};
    if (!account.capabilityFlaggedAt) account.capabilityFlaggedAt = {};
    account.capabilities[model] = false;
    account.capabilityFlaggedAt[model] = Date.now();
    saveAccounts(accounts);
  }
}

export async function resetAccount(email: string) {
  const account = accounts.find(a => a.email === email);
  if (account) {
    account.healthScore = 100;
    account.consecutiveFailures = 0;
    account.cooldowns = {};
    account.modelScores = {};
    account.history = [];
    // Reset must undo a wrong "unsupported" flag too — it was the one piece of
    // account state with no way back short of editing accounts.json.
    account.capabilities = {};
    account.capabilityFlaggedAt = {};
    delete account.challenge;
    const keysToDelete = [];
    for (const [key] of cooldownMap) {
      if (key.startsWith(email + "|")) keysToDelete.push(key);
    }
    for (const key of keysToDelete) cooldownMap.delete(key);
    await saveAccounts(accounts);
  }
}

export async function updateAccountProject(email: string, projectId: string) {
  const account = accounts.find(a => a.email === email);
  if (account) {
    account.projectId = projectId;
    account.managedProjectId = projectId;
    await saveAccounts(accounts);
  }
}

export function getEarliestReset(_pool: "cli" | "sandbox"): string | null {
  const usable = accounts.filter(a => a.refreshToken && a.quota);
  if (usable.length === 0) return null;
  let resetTimes: number[] = [];
  for (const acc of usable) {
    acc.quota?.forEach(q => {
      if (q.resetTime) {
        const t = new Date(q.resetTime).getTime();
        if (!isNaN(t)) resetTimes.push(t);
      }
    });
  }
  if (resetTimes.length === 0) return null;
  const diffMs = Math.max(0, Math.min(...resetTimes) - Date.now());
  return `${Math.floor(diffMs / 3600000)}h ${Math.floor((diffMs % 3600000) / 60000)}m`;
}

export async function addAccount(account: AntigravityAccount) {
  const existing = accounts.find(a => a.email === account.email);
  if (existing) Object.assign(existing, account);
  else accounts.push(account);
  await saveAccounts(accounts, { immediate: true });
}

export async function removeAccount(email: string) {
  accounts = accounts.filter(a => a.email !== email);
  await saveAccounts(accounts, { immediate: true });
}

export function emitAccountFlash(email: string, status: "success" | "error" = "success") {
  adminEventBus.emit("flash", { email, status });
}

export function ensureFingerprint(account: AntigravityAccount): void {
  if (!account.fingerprint || !account.fingerprint.clientMetadata?.sqmId) {
    account.fingerprint = generateFingerprint(account.email);
    saveAccounts(accounts);
  }
}

/**
 * Set the tier for an account (ultra/pro/free).
 */
export async function setAccountTier(email: string, tier: 'ultra' | 'pro' | 'free'): Promise<boolean> {
  const account = accounts.find(a => a.email === email);
  if (!account) return false;
  account.tier = tier;
  await saveAccounts(accounts);
  return true;
}

/**
 * Auto-detect tier from quota data.
 * Ultra: all quotas have remainingFraction > 0.7
 * Pro: average remainingFraction > 0.3
 * Free: everything else
 */
export function autoDetectTier(account: AntigravityAccount): 'ultra' | 'pro' | 'free' {
  if (!account.quota || account.quota.length === 0) return 'free';
  const avgRemaining = account.quota.reduce((sum, q) => sum + q.remainingFraction, 0) / account.quota.length;
  const allHigh = account.quota.every(q => q.remainingFraction > 0.7);
  if (allHigh) return 'ultra';
  if (avgRemaining > 0.3) return 'pro';
  return 'free';
}

/**
 * Refresh tiers for all accounts based on their current quota data.
 */
export async function refreshAllTiers(): Promise<void> {
  for (const account of accounts) {
    account.tier = autoDetectTier(account);
  }
  await saveAccounts(accounts);
}

export function regenerateFingerprint(email: string): void {
  const account = accounts.find(a => a.email === email);
  if (account) {
    account.fingerprint = generateFingerprint(email);
    saveAccounts(accounts);
  }
}
