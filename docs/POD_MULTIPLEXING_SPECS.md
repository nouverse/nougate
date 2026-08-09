# POD_MULTIPLEXING_SPECS.md - Product Pod Account Capping & Jitter Floor Specification

**Author:** Nouva (`nouva.agent@nouverse.tech`)  
**Date:** 2026-08-09  
**Target Repository:** `projects/nougate`  

---

## 🎯 Objective

When `nougate` is deployed as a Product Pod (multi-tenant or per-user instance behind Cloudflare WARP Egress), running a large pool of accounts without caps can trigger rate-limiting or anti-abuse detection from upstream LLM providers (GitHub Copilot, Google Antigravity).

To safeguard system stability and avoid origin IP exposure:
1. **Cloudflare WARP Egress stays ENABLED** (Never bypass to Direct ISP, to prevent exposing homelab origin IP).
2. **Account Rotation Pool Capping** via `MAX_ACCOUNT_MULTIPLEXING`.
3. **Minimum Jitter Floor Enforcement** via `BOTTOM_JITTER` (or `BOTTOM_JITTER_MS`).

---

## ⚙️ Environment Variables Specification

| Variable Name | Type | Default | Description |
|---|---|---|---|
| `MAX_ACCOUNT_MULTIPLEXING` | `number` | `5` | Maximum number of top healthy accounts allowed in the active rotation pool per provider selection. |
| `BOTTOM_JITTER` / `BOTTOM_JITTER_MS` | `number` | `0` (or unset) | Hard lower-bound (floor) for request jitter/delay in milliseconds. Config values below this floor are automatically clamped to `BOTTOM_JITTER`. |

---

## 🏗️ Technical Architecture & Code Changes

### 1. Configuration Types (`apps/backend/src/config/types.ts`)

Extend `RotationConfig` (or top-level `ProxyConfig`) with optional floor & capping fields:

```typescript
export interface RotationConfig {
  strategy: 'hybrid' | 'sticky' | 'round-robin' | 'random' | 'least-used';
  /** Maximum healthy accounts allowed in active rotation pool (default: 5) */
  maxMultiplexingAccounts?: number;
  /** Minimum jitter/delay floor in milliseconds */
  bottomJitterMs?: number;
  cooldown: {
    defaultDurationMs: number;
    maxDurationMs: number;
  };
}
```

---

### 2. Configuration Parser & Manager (`apps/backend/src/config/manager.ts`)

Parse ENV overrides during configuration load:

```typescript
// Parse MAX_ACCOUNT_MULTIPLEXING (default 5)
const maxMultiplexingEnv = process.env.MAX_ACCOUNT_MULTIPLEXING;
const maxMultiplexing = maxMultiplexingEnv ? parseInt(maxMultiplexingEnv, 10) : 5;

// Parse BOTTOM_JITTER or BOTTOM_JITTER_MS
const bottomJitterEnv = process.env.BOTTOM_JITTER || process.env.BOTTOM_JITTER_MS;
const bottomJitterMs = bottomJitterEnv ? Math.max(0, parseInt(bottomJitterEnv, 10)) : 0;

// Apply to config object
config.rotation.maxMultiplexingAccounts = Number.isNaN(maxMultiplexing) ? 5 : maxMultiplexing;
config.rotation.bottomJitterMs = Number.isNaN(bottomJitterMs) ? 0 : bottomJitterMs;
```

---

### 3. Account Selection Capping (`getBestAccount`)

In provider account schedulers (e.g. `copilot`, `antigravity` account managers):

When sorting candidate accounts by health score / LRU / quota, restrict the candidate pool to `maxMultiplexingAccounts` before selecting:

```typescript
// Filter healthy accounts
const healthyAccounts = accounts.filter(acc => isAccountHealthy(acc));

// Sort by score/health/LRU
const sortedAccounts = sortAccounts(healthyAccounts);

// Slice active pool to maxMultiplexingAccounts (e.g. top 5)
const activePool = sortedAccounts.slice(0, config.rotation.maxMultiplexingAccounts ?? 5);

// Pick from active pool (round-robin / random / sticky)
const selected = selectFromPool(activePool);
```

---

### 4. Jitter Floor Enforcement (`BOTTOM_JITTER`)

When calculating delay/jitter prior to nembak upstream API:

```typescript
const configuredJitterMs = providerConfig.jitterMs ?? 1000; // e.g. 1000ms
const bottomJitterMs = globalConfig.rotation.bottomJitterMs ?? 0;

// Enforce floor: effective jitter can NEVER be lower than bottomJitterMs
const effectiveJitterMs = Math.max(configuredJitterMs, bottomJitterMs);

if (effectiveJitterMs > 0) {
  const actualDelay = Math.floor(Math.random() * effectiveJitterMs);
  await sleep(actualDelay);
}
```

---

## 🛡️ Operational Summary & Safety

* **WARP Egress Intact:** Traffic outbound continues to route through WARP tunnel.
* **Controlled Rotation Density:** Max 5 accounts rotating concurrently per pod instance.
* **Enforced Delay Floor:** Admins can enforce global minimum delay (e.g. `BOTTOM_JITTER=1500`) via container ENV, overriding any user/config attempt to set zero delay.
