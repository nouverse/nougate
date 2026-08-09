# Nougate Architecture

How the gateway is put together, and why. For task-level guidance when editing it,
see the `nougate-contributing` skill in `../.claude/skills/`.

Nougate is provider-agnostic by construction: the core never knows a provider's name.
Behaviour that differs per provider is expressed as an **optional method on the
`IProvider` contract**, and callers test for the method rather than the id. Adding a
provider is adding a directory; adding a provider *feature* is implementing one more
method.

---

## 1. Planes

**Data plane** — translates client protocol to upstream, resolves the model, picks an
account, streams the response back.

**Control plane** — dashboard, admin API, auth, metrics, SSE event stream.

```mermaid
graph TD
    Client[CLI tools / IDEs / SDKs] -->|OpenAI or Anthropic protocol| Ingress[Bun.serve → handleRequest]

    subgraph DataPlane["Data plane (provider-agnostic)"]
        Ingress --> MW[middleware: CORS, path normalise, log]
        MW --> Guard[dashboard auth guard]
        Guard --> Find[findHandler by path + method]
        Find --> KeyAuth[gateway API key check]
        KeyAuth --> Resolve[resolveModel 'provider:model']
        Resolve --> Reg[provider registry]
        Reg --> Proto[protocol handler: openai / anthropic]
    end

    subgraph Providers["Providers (isolated plugins)"]
        Proto -->|execute| AG[Antigravity]
        Proto -->|execute| CP[Copilot]
        Proto -->|execute| CU[CustomProvider × N]
    end

    AG --> Google[Google Cloud Code Assist]
    CP --> GitHub[GitHub Copilot API]
    CU --> Any[Any OpenAI/Anthropic-compatible endpoint]

    subgraph Control["Control plane"]
        Admin[router/admin, metrics, api-keys,<br/>custom-providers, users, auth]
        DB[(SQLite / Postgres via Drizzle)]
        Bus[adminEventBus]
        Admin <--> DB
        Bus -->|SSE /api/sse| Dash[React dashboard]
        Dash <--> Admin
    end

    Proto -.->|token usage, cost| DB
    AG -.->|cooldowns, status| Bus
    CU -.->|updates| Bus
```

---

## 2. Request pipeline

`router/index.ts :: handleRequest` is the single entry point. In order:

1. **Normalise + log** the path; answer CORS preflight.
2. **`handleAuthRoute`** — `/api/auth/*` runs first and returns directly, bypassing
   the CORS wrapper so its `Set-Cookie` headers survive intact.
3. **`enforceDashboardAuth`** — everything except the proxy routes, `/oauth/start`,
   `/oauth-callback` and the frontend assets requires a dashboard session. A user
   flagged `mustChangePassword` can reach only `/api/auth/{me,logout,profile}`.
4. **`findHandler(path, method)`** — if a protocol handler claims the path, this is a
   proxy request:
   - **Gateway API key** check — unconditional, returning a 401 shaped for the
     protocol the client is speaking.
   - **Preview body** — the body is cloned and parsed only to read `model`, so
     routing can happen before the handler consumes the stream.
   - **Client id** — `x-client-id` header → `client_id` query → the API key's name →
     `unknown`. A named key therefore gives per-machine cost attribution for free.
   - **`resolveModel`** splits `provider:model`; an unprefixed model falls to the
     default provider.
   - The handler receives a `RequestContext` and returns a `Response`.
5. **`handleAdminRoute`** — admin API, OAuth routes, SSE, and the frontend SPA.
6. Otherwise 404.

---

## 3. The contracts

All in `core/interfaces.ts`.

### `IProvider`

```ts
export interface IProvider {
  readonly id: string;            // lowercase; becomes the model prefix
  readonly displayName: string;

  init(): Promise<void>;
  getBestAccount(options: AccountRequestOptions): Promise<IAccount | null>;
  updateAccountUsage(accountId: string, success: boolean, meta): Promise<void>;
  getAccounts(): IAccount[];
  getModelRegistry(): IModelRegistry;
  getSupportedModels(): string[];
  execute(params: ProviderExecuteParams): Promise<Response>;

  // Capabilities — declaring one turns the matching dashboard feature on.
  readonly accountFlow?: 'oauth-redirect' | 'device-code' | 'api-key';
  getQuotas?(): Promise<IProviderQuota[]>;
  getStrategy?(): string;
  setStrategy?(strategy: string): Promise<void>;
  getConfig?(): any;
  updateConfig?(updates: any): Promise<any>;
  addAccount?(body: any): Promise<any>;
  removeAccount?(accountId: string): Promise<void>;
  resetAccount?(accountId: string): Promise<void>;
  resetAllAccounts?(): Promise<void>;
  markAccountCooldown?(accountId: string, pool: string, duration?: string): Promise<void>;
  getCooldowns?(): Record<string, number>;
  handleAccountAction?(accountId: string, action: string, payload?: any): Promise<any>;
}
```

### Capabilities, not names

The rule the whole design rests on. `/api/providers/:id` computes:

```ts
const supportsQuota = typeof p.getQuotas === "function";
return { …, capabilities: { quota: supportsQuota, accountFlow: p.accountFlow ?? null }, quotas };
```

`accountFlow` works the same way and selects which add-account form to render.

The dashboard shows its **Quota** tab from `capabilities.quota` — never from the
provider id, and never from whether data happens to have loaded. Antigravity keeps
the tab while its accounts are still verifying, and shows an explanatory empty state
inside it; Copilot gained the same tab by implementing one method, with zero changes
to the router or the UI.

`IProviderQuota` is the normalised shape every provider reports:

```ts
interface IProviderQuota {
  id: string; label: string; remainingFraction: number;
  unlimited?: boolean; used?: string; limit?: string; unit?: string;
  resetIn?: string; modelIds?: string[];
}
```

Antigravity counts per-model rolling windows and averages them across its account
pool. Copilot counts monthly per-entitlement allowances (chat / completions /
premium interactions) per seat. Neither shape reaches the dashboard — only
`IProviderQuota` does.

### `IProtocolHandler`

```ts
interface IProtocolHandler {
  readonly protocol: ProtocolId;   // 'openai' | 'anthropic' | …
  readonly paths: string[];
  readonly methods: string[];
  handle(ctx: RequestContext): Promise<Response>;
}
```

Registered in `core/registry.ts` the same way providers are, so the router matches
paths without a table of its own.

### Model namespacing

Clients address every model as `provider:model-id`. `core/model-resolver.ts` parses
it; `getModelRegistry().getSpec()` resolves it to an `IModelSpec` carrying
`maxOutputTokens`, thinking mode, pool, timeout and optional per-1M prices. With
`bypassModelValidation` on, an unknown model is passed through and the upstream is
treated as the authority.

---

## 4. Protocol translation

Client protocol and upstream API style are independent, so all four combinations
must work. The shared mappers live in `core/mappers/` and are used by every provider:

| Client | Upstream | Mapper |
|---|---|---|
| Anthropic | OpenAI | `anthropic-to-openai.ts` |
| OpenAI | Anthropic | `openai-to-anthropic.ts` |
| OpenAI | OpenAI | `openai-passthrough.ts` (sanitising only) |
| Anthropic | Anthropic | passthrough with model swap |

A provider whose upstream speaks neither — Antigravity speaks Google's Cloud Code
Assist protocol — supplies its own mappers under `providers/<id>/mappers/`.

Streaming is transformed, never buffered: the upstream `ReadableStream` is piped
through a transformer that rewrites events and extracts usage as bytes pass.

```mermaid
sequenceDiagram
    autonumber
    actor Client
    participant R as handleRequest
    participant H as Protocol handler
    participant P as Provider
    participant U as Upstream

    Client->>R: POST /anthropic/v1/messages { model: "copilot:claude-opus-4.6" }
    R->>R: API key check → resolveModel → registry lookup
    R->>H: handle(ctx)
    H->>P: execute({ protocol: 'anthropic', body, modelSpec, ctx })
    P->>P: getBestAccount() → ensure token
    P->>U: POST /chat/completions (OpenAI style)
    U-->>P: SSE stream (OpenAI events)
    P-->>H: stream piped through openai→anthropic transformer
    H-->>Client: Anthropic SSE
    H->>H: record usage + cost (buffered, non-blocking)
```

---

## 5. Accounts and rotation

An account is whatever lets a provider make a call: an OAuth identity for
Antigravity, a GitHub token for Copilot, an API key for a custom provider. All are
`IAccount`, all carry a health score, cooldowns and last-used timestamp, and all
render in the same dashboard views.

Selection: drop excluded ids, drop anything still cooling down, then highest health
score with least-recently-used as the tie-break. Strategy (`hybrid`, `sticky`,
`round-robin`, `least-used`, `random`) is global config; scoring weights and
penalties are too, so providers stay comparable.

Failure of one account is not failure of the request — the executor retries with the
next account before surfacing an error.

---

## 6. Custom providers

`providers/custom/` is a single implementation instantiated many times, once per row
in `custom_providers`. It is the reference for "provider as data":

- The record carries id, display name, base URL, API style (`openai` | `anthropic`),
  extra headers and an enabled flag.
- Keys are accounts, with rotation, health and cooldown.
- Models are rows, optionally auto-discovered from the upstream `/models` endpoint.
  Re-syncing adds new models and never overwrites hand-edited prices.
- `refresh()` re-reads the row, keys and specs into in-memory snapshots, because
  `IProvider`'s getters are synchronous while the store is async.
- Registered **last** in `server.ts`, so a user-chosen id can never shadow a built-in.

---

## 7. Persistence

Two stores, chosen by what the data is.

**SQLite or Postgres** (Drizzle, selected by `DB_URL`) for anything queried or
aggregated: users, gateway API keys, custom providers and their keys and models,
per-request token usage, daily rollups.

**JSON files** for provider accounts and configs, so they stay inspectable and
hand-editable. Written atomically (temp + rename) and coalesced, because they hold
OAuth refresh tokens.

Everything lives under one directory — `/app/data` in Docker, `./data` locally —
resolved through `core/paths.ts`, never from `process.cwd()`. There are no fallback
locations and no seed copies inside the image.

The two Drizzle schemas (`schema/sqlite.ts`, `schema/pg.ts`) are the same tables
written twice, because Drizzle types tables per dialect. `tests/unit/schema-parity.test.ts`
fails the build if they drift in tables, columns, nullability, defaults or JS types.
Postgres deliberately stores epoch milliseconds as `bigint` and booleans as `0/1`, so
rows round-trip identically and no call site branches on the backend.

---

## 8. Metrics

Every proxied request is recorded: provider, model, protocol, client, gateway API
key, token counts, duration, status, and the tokens compression saved.

- **Non-blocking.** Rows buffer in memory and batch-insert on a timer, so a slow
  database cannot stall an in-flight stream.
- **Real usage where the upstream reports it**, estimated from payload size
  otherwise, and flagged as estimated when so.
- **Cost is resolved, never guessed:** the model's own rate → the built-in price book
  matched on model family → an optional blanket rate (off by default) → otherwise
  **unpriced at $0**, badged in the dashboard. An invented rate is
  indistinguishable from a real one on a chart.
- **Retention:** hourly rollup into daily aggregates; detail rows pruned at 14 days,
  rollups at 90. Long windows are served from the rollup table, which also carries
  the API key so key filtering works across the full 90 days.

---

## 9. Auth

Two independent systems, because the clients are different.

**Dashboard** — username + password in the database, argon2id hashes, stateless
HMAC-signed session cookies. Always on; there is no switch. The signed-in user is
re-read on every request, so deleting an account takes effect immediately.

**Proxy routes** — gateway API keys (`sk-nou-…`), SHA-256 hashed, shown once. Always
required: `/openai/v1/*` and `/anthropic/v1/*` reject unauthenticated requests in the
shape the client's protocol expects, and there is no config that relaxes it. An
instance with no keys serves nobody, which is the safe direction for something
reachable from the internet — "none configured" must never read as "none needed".
Verification is synchronous against an in-memory cache, refreshed on mutation.

CLI clients cannot hold a browser session, which is exactly why the two are separate.

---

## 10. Known gap: browser-redirect OAuth is not yet agnostic

`/oauth/start` and `/oauth-callback` in `router/admin.ts` are hardcoded to
Antigravity — they import `exchangeCode`, `getUserEmail` and `getProjectId` directly
and construct an `AntigravityAccount`. Copilot avoids the issue entirely by using a
device flow through `addAccount()`, which needs no global route.

A second redirect-OAuth provider requires generalising those two routes first:
optional `getOAuthStartUrl(baseUrl, state)` / `handleOAuthCallback(code, baseUrl)` on
`IProvider`, provider id carried in the OAuth `state` parameter (alongside a CSRF
nonce, which the current route lacks), and the Antigravity specifics moved into the
provider. Details in the `nougate-contributing` skill.

Prefer device flow or key-based auth where the upstream offers it.

---

## 11. Adding a provider, in short

1. `apps/backend/src/providers/<id>/` — implement `IProvider`.
2. Credentials via device flow or API keys where possible (see the gap above).
3. Reuse `core/mappers/` unless the upstream speaks something exotic.
4. Provider-local settings in `data/providers/<id>/config.json`, never global config.
5. Optional capabilities — `getQuotas()`, `getConfig()`, `addAccount()` — light up
   dashboard features with no core changes.
6. Register in `server.ts` before `initCustomProviders()`.
7. Tests under `apps/backend/tests/unit/`.

Clients can then call `<id>:<model>` on either protocol.
