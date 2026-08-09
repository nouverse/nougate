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

---

## 📌 Implementation notes (as shipped)

The behaviour matches the objective above. Three things landed differently from
the sketch in the code samples, each for a stated reason.

### No built-in default for either variable

The table above gives `MAX_ACCOUNT_MULTIPLEXING` a default of `5`. It shipped
with **no default**: unset means uncapped, exactly as every deployment behaves
today. A default of 5 would silently bench accounts an operator had already added,
on nothing more than an upgrade. `BOTTOM_JITTER` behaves the same way — unset
means no clamping at all, and providers get the window they configured.

### Neither value is persisted into `config.json`

Section 2 parses both into `config.rotation`. They are instead read from the
environment on each use, via `core/jitter.ts` and `core/rotation-pool.ts`.
Merging them into the saved config would write the value to disk, so removing the
variable from the container would leave the old floor in force — the opposite of
"unset means not enforced". `RotationConfig` is unchanged.

### Jitter is applied by the gateway, not by each provider

Section 4 shows the clamp at each provider's call site. Doing it there is what
made the floor unenforceable in the first place: three duplicated fields and three
duplicated sleeps, any of which a new provider could omit. Instead:

- `JitterConfig` lives in `core/jitter.ts` and every provider config uses it.
- `getJitterConfig()` is a **required** member of `IProvider` — a new provider
  that omits it does not compile.
- The sleep happens once, in `executeProviderRequest`, the single path both
  protocol handlers use to reach a provider. The per-provider jitter blocks in
  the Antigravity and Copilot executors were removed.

One consequence worth knowing: jitter is now applied **once per client request**
rather than once per upstream retry attempt. Retries already carry their own
parsed backoff, so this removes a delay that was compounding, not one that was
doing work.

### `MAX_ACCOUNT_MULTIPLEXING` is a hard limit on adding, not only on rotating

Section 3 caps the *selection* pool. That alone would let an operator who set a
limit of 5 end up holding eight accounts with three quietly benched — the pod
would look compliant while storing credentials it never uses.

So the limit is enforced in two places:

1. **On add — the one that refuses.** `assertAccountSlotAvailable()` throws
   `AccountLimitError` (409) when a provider is already at the cap. It sits in
   the manager-level `addAccount()` for Antigravity and Copilot, and in
   `addProviderKey()` for custom providers, so *every* add path is covered:
   the OAuth browser callback, the `/api/providers/:id/accounts/add` route, the
   Copilot device-flow completion, and the custom-provider key form.

   Re-authenticating an account that already exists is an **update**, not an add,
   and is never blocked — otherwise a full pod could never refresh its tokens.

2. **On selection — the backstop.** `capRotationPool()` still trims the ranked
   candidate list. With the add guard in place this is normally a no-op, but it
   keeps the limit true when the cap is lowered after accounts were added, or
   when a state file is edited by hand.

The dashboard reports the count against the limit (`3 / 5`) in the sidebar, on
the provider page, and on a custom provider's API-keys panel, turning amber when
full. `null` limit means unset, and renders as a plain count.

`capRotationPool()` never reorders, so it cannot change which account wins — only
how far down the ranking a request may fall. Antigravity's cache-first sticky
account is honoured before the cap, which is what preserves prompt caching; this
does not widen the working set, since every non-sticky selection goes through the
cap and so the set of accounts that can become sticky is itself capped.
