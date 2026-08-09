# Adding a provider

A provider is a self-contained plugin under `apps/backend/src/providers/<id>/`. It
owns its credentials, accounts, model registry, upstream call and response mapping.
Core code must never learn its name.

---

## 1. The contract

`IProvider` in `core/interfaces.ts`. Required members:

```ts
readonly id: string;            // lowercase, [a-z][a-z0-9_-]* — becomes the model prefix
readonly displayName: string;   // see the getter warning below

init(): Promise<void>;
getJitterConfig(): JitterConfig;   // see below — required, not a capability
getBestAccount(options: AccountRequestOptions): Promise<IAccount | null>;
updateAccountUsage(accountId, success, meta): Promise<void>;
getAccounts(): IAccount[];
getModelRegistry(): IModelRegistry;
getSupportedModels(): string[];
execute(params: ProviderExecuteParams): Promise<Response>;
```

Everything else is optional and is a **capability**: implementing it is what turns
the corresponding dashboard feature on. `getQuotas()` gives you the Quota tab.
`getConfig()`/`updateConfig()` give you the Provider Config tab. `addAccount()`
gives you the add-account button. No registration list, no switch statement.

### `getJitterConfig()` is required, and you do not implement the waiting

Jitter used to be three fields copied into each provider's config plus a
`min + random * (max - min)` block next to `fetch`. That made it unenforceable:
an operator could not set a minimum spacing for the whole deployment, and a new
provider could ship with no delay at all.

So the shape is `JitterConfig` from `core/jitter.ts`, and the sleep happens once
in `executeProviderRequest` — the single path both protocol handlers use to reach
a provider. Your job is only to declare the window:

```ts
getJitterConfig(): JitterConfig {
  return normalizeJitterConfig(getYourConfig().features);
}
```

Returning `DEFAULT_JITTER_CONFIG` is a fine answer. Omitting the method is not,
and will not compile. **Do not put a jitter sleep in your executor** — it would
stack on top of the one the gateway already applied, and it would sit below the
`BOTTOM_JITTER` floor rather than above it.

If your provider stores config in a JSON file, extend `JitterConfig` on its
features interface (`AntigravityFeaturesConfig`, `CopilotFeaturesConfig`) so the
three field names cannot drift.

### `displayName` must read through to live state

If the name can change at runtime (custom providers can), make it a getter. A field
assigned in the constructor freezes at registration time and the sidebar keeps
showing the old name until a restart — this was a real bug.

```ts
get displayName(): string {
  return this.record.displayName;
}
```

### Sync contract, async storage

`getAccounts()`, `getModelRegistry()` and `getSpec()` are **synchronous** and sit on
the request path. If your state lives in the database, hold an in-memory snapshot
and refresh it on mutation — see `providers/custom/index.ts` (`private keys`,
`private specs`, `async refresh()`). Do not make the hot path await a query.

---

## 2. Directory layout

Mirror the existing providers:

```
providers/<id>/
  index.ts              # the IProvider class + any pure helpers worth testing
  auth/                 # credential acquisition, storage, refresh
    manager.ts          #   account list, rotation, scoring, cooldowns
    storage.ts          #   load/save via createStateFileWriter
    types.ts            #   YourAccount extends IAccount
  config/               # provider-local config + model specs
  upstream/executor.ts  # the actual fetch, retry, account failover
  mappers/              # wire-format translation, if the upstream is not OpenAI/Anthropic
```

Provider-local config belongs in `data/providers/<id>/config.json`, **never** in the
global `data/config.json`. Global config holds only settings that apply to the whole
gateway; feature flags, polling intervals and blacklists are provider-local and are
edited from that provider's Provider Config tab.

**Not everything a provider needs is config.** The Provider Config tab renders
exactly what `getConfig()` returns, as a JSON editor with no validation beyond
"is it JSON". So a value only belongs in the config shape if a wrong entry is
*recoverable from that same screen*. Upstream URLs are the counter-example: they
are code (`providers/antigravity/upstream/endpoints.ts`), because a typo there
takes the provider down and the editor gives no way to say so. Same test for
anything else structural — wire-format constants, retry ladders, header sets.

---

## 3. Authentication

Three shapes, in order of preference.

**Declare which flow you use.** `readonly accountFlow: 'oauth-redirect' | 'device-code'
| 'api-key'` on the provider is what selects the dashboard's add-account form. It is
surfaced as `capabilities.accountFlow` on `/api/providers/:id`. Omit it and the
accounts list renders read-only.

This is the same capability rule as `getQuotas()`, and for the same reason: the tab
used to choose with `id === 'copilot' ? deviceFlow : googleOAuth`, so every custom
provider was shown a Google sign-in dialog it had no use for.

### A. Self-contained (device flow / token paste) — preferred

Everything happens through `addAccount(body)`, which the dashboard already calls.
No new routes. Copilot does this:

```ts
async addAccount(body: any): Promise<any> {
  if (!body || Object.keys(body).length === 0) {
    return { step: 'device_flow', ...(await startDeviceFlow()) };  // dashboard shows the code
  }
  if (body.personalToken) { /* verify, persist, return the mapped account */ }
  throw new Error('Expected an empty body to start device flow, or personalToken.');
}
```

Polling for completion goes through `handleAccountAction(accountId, action, payload)`
or a provider-specific admin route. Copilot exposes
`GET /api/providers/copilot/device-status?device_code=…`.

### B. API keys — trivial

Declare `accountFlow = 'api-key'` and implement `addAccount({ apiKey, label })`; the
shared `ApiKeyAccountsTab` then handles the whole UI, including rotation stats,
reset and removal, through the generic `/api/providers/:id/accounts/*` routes.

Keys *are* accounts: give each a health score, rotate least-recently-used, cool one
down on `429`/`503`, fail over mid-request. `providers/custom/` is the reference
implementation; do not invent a second rotation mechanism.

### C. Browser-redirect OAuth — **currently hardcoded, read this first**

`docs/ARCHITECTURE.md` used to describe a provider-agnostic OAuth flow keyed on the OAuth
`state` parameter. That is a design, not the code. As it stands:

- `GET /oauth/start` → `Response.redirect(generateAuthUrl())` — Antigravity's.
- `GET /oauth-callback` → `handleOAuthCallback()` in `router/admin.ts`, which imports
  `exchangeCode`, `getUserEmail`, `getProjectId` from Antigravity directly and
  builds an `AntigravityAccount`.

Both routes are in `auth/guard.ts`'s public allowlist, since the OAuth provider
redirects a browser that carries no session.

**To add a second redirect-OAuth provider you must generalise these two routes
first.** Do not add a second pair of paths, and do not add an `if (provider === …)`.
The intended shape:

1. Add optional contract methods:
   ```ts
   getOAuthStartUrl?(baseUrl: string, state: string): string;
   handleOAuthCallback?(code: string, baseUrl: string): Promise<void>;
   ```
2. `/oauth/start?provider=<id>` looks the provider up in the registry, generates the
   URL, and puts the provider id in the OAuth `state` parameter.
3. `/oauth-callback` reads the provider id back out of `state`, looks it up, and
   delegates. It knows nothing about Google, GitHub or anyone else.
4. Move Antigravity's `exchangeCode`/`getUserEmail`/`getProjectId` calls out of
   `router/admin.ts` and into `AntigravityProvider.handleOAuthCallback`.

`state` must also carry CSRF protection — a random nonce alongside the provider id,
checked on return. The current single-provider route has none.

**Redirect URI:** derived from `baseUrl` in the global config, overridable with the
`BASE_URL` env var. It must be registered with the upstream OAuth app exactly.
`docker-compose.prod.yml` pins `BASE_URL` rather than interpolating `${BASE_URL:-…}`,
so a developer's `.env` cannot downgrade production to `localhost`.

---

## 4. Accounts, rotation and health

`IAccount` carries `healthScore`, `lastUsed`, `cooldowns`, `consecutiveFailures`,
`tokenUsage`. Reuse the shape and the scoring weights from the global config
(`scoring.penalties`, `scoring.rewards`, `scoring.weights`) rather than inventing a
scale — the dashboard renders all providers with the same bars.

`getBestAccount()` should: drop `options.excludeIds`, drop anything still in
cooldown, then pick the highest health score, breaking ties by least-recently-used.
Return `null` when nothing is available; the protocol handler turns that into a
protocol-shaped error.

`MAX_ACCOUNT_MULTIPLEXING` bounds how many accounts a provider may hold, and it
is your job to honour it in **two** places (`core/rotation-pool.ts`):

- **Where you store a new account** — call `assertAccountSlotAvailable(subject, count)`
  *before* pushing it. It throws `AccountLimitError` (status 409), which the
  routers already map to a response. Put this in the function that actually
  appends to your account list, not in the route handler: providers here have
  three or four add paths (OAuth callback, device flow, manual token, API key
  form) and guarding the storage point covers all of them at once.
  Never block an update — if the account already exists, it is a re-auth.
- **Where you rank candidates** — pass the sorted list through `capRotationPool()`
  before selecting. It only trims the tail, so it never changes which account
  wins, but the list must be sorted first or it will bench the wrong ones.

The dashboard shows the count against the limit automatically, from `accountLimit`
in the `/api/providers` payload. You do not add UI for it.

---

## 5. Executing a request

`execute({ protocol, body, resolvedModel, modelSpec, ctx })` returns a `Response`
already in the **client's** protocol — the caller does no translation.

Four combinations exist (client OpenAI/Anthropic × upstream OpenAI/Anthropic) and
all four are already implemented in `core/mappers/`:

- `anthropic-to-openai.ts` — Anthropic client, OpenAI upstream
- `openai-to-anthropic.ts` — OpenAI client, Anthropic upstream
- `openai-passthrough.ts` — matching pair, with sanitising

Use them. A provider whose upstream speaks something else (Antigravity speaks
Google) writes its own mappers under `providers/<id>/mappers/`.

**Always wrap the upstream call in try/catch and return a protocol-shaped JSON
error.** An unhandled throw becomes Bun's HTML debug page, which leaks filesystem
paths to the client. This has happened.

Streaming: return the upstream `ReadableStream` piped through a transformer. Never
buffer an SSE response to rewrite it — `openai-passthrough.ts` shows the pattern of
passing bytes through untouched while extracting usage.

---

## 6. Register it

`server.ts`, in order:

```ts
const yours = new YourProvider();
await yours.init();
registerProvider(yours);
```

Custom providers are registered **last** so a user-created id can never shadow a
built-in one. Keep it that way.

---

## 7. Quota (optional capability)

Implement `getQuotas(): Promise<IProviderQuota[]>` and the Quota tab appears. The
normalisation is entirely yours; the dashboard renders the returned shape and
nothing else.

```ts
interface IProviderQuota {
  id: string;                 // stable key within the provider
  label: string;              // what this limit covers
  remainingFraction: number;  // 0–1
  unlimited?: boolean;        // no cap: `used` is consumption, the fraction means nothing
  used?: string;
  limit?: string;
  unit?: string;              // "requests", "credits" — your vocabulary, not the UI's
  resetIn?: string;           // pre-formatted, e.g. "4h 59m"
  modelIds?: string[];
}
```

Lessons from the two implementations:

- **Guard against `0/0`.** Copilot Business reports `entitlement: 0, remaining: 0,
  unlimited: true`; `remaining / entitlement` is `NaN` and renders an empty bar on an
  account with no limit at all. Prefer a `percent_remaining`-style field and only
  fall back to arithmetic when the denominator is non-zero.
- **Merging across accounts is a semantic choice.** Antigravity averages, because its
  accounts are one pool for the same models — three accounts at 100/50/0% leave the
  pool 50% full, which is what rotation will find. Copilot also averages the fraction
  but *sums* usage, because quota belongs to a seat. Whichever you pick, describe the
  worst account in the text fields, and emit no `limit` when a summed usage would not
  be a ratio against it.
- **An account with no data contributes nothing**, not a zero. Otherwise adding a
  fresh account makes a healthy provider look exhausted.
- **Cache it.** Quota is a network call; the dashboard must not turn a page refresh
  into upstream traffic. Copilot uses a 5-minute TTL per account
  (`providers/copilot/auth/quota.ts`); Antigravity uses a background poller and
  `getQuotas()` just reads the cache. Either is fine — no uncached fetch.
- **Extract the merge as a pure exported function** so it can be tested without
  network or module state. Both providers do.

---

## 8. Tests

Add `tests/unit/<provider>-*.test.ts`. Cover, at minimum:

- the model registry resolves `provider:model` and rejects unknown ids
- account rotation picks the healthiest, skips cooldowns, and returns `null` when empty
- credentials never leak: assert the masked form in whatever the API returns
- quota mapping, if implemented — build fixtures from a **real captured response**,
  not from what the docs say

Verifying an undocumented upstream: write a throwaway script under
`apps/backend/tests/tmp/`, run it with `bun run`, print the response **structure**
with secrets redacted, then delete the directory. Never paste a live token into a
committed file, and never print one.
