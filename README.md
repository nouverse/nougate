# Nougate

> Route any LLM provider through any protocol. One gateway, isolated providers, and a model id that either names a provider or lets the gateway choose one.

**Nougate** is Nouverse's internal LLM gateway — a modular router that sits between your tools and AI providers. Route requests through OpenAI or Anthropic protocols, authenticate via isolated per-provider accounts, and address a model either way:

```jsonc
{ "model": "antigravity:gemini-3.8-flash-medium" }  // pinned — this provider, never another
{ "model": "claude-sonnet-4-6" }             // routed — the gateway picks, and fails over
```

![Nougate dashboard — the Token Metrics page, showing spend against what compression and the prompt cache saved, with the top models and providers behind it](screenshots/screenshot.png)

---

## Features

### Core
- **Multi-Protocol**: Expose providers via OpenAI (`/openai/v1/`) and Anthropic (`/anthropic/v1/`) compatible APIs simultaneously.
- **Multi-Provider**: Pluggable provider system — each provider owns its auth, accounts, config, and model registry.
- **Model Namespacing, with an escape hatch**: `provider:model-id` pins a request to one provider (e.g. `antigravity:gemini-3.8-flash-medium`). A bare `model-id` instead fans out to every provider that serves it — see [Smart routing](#smart-routing).
- **Per-Provider Auth Isolation**: Credentials and account storage are fully isolated per provider.
- **Custom Providers**: Define your own upstream from the dashboard — pick an ID, base URL, OpenAI or Anthropic API style, keys and pricing, then call it as `{provider_id}:{model}`.
- **Gateway API Keys**: Issue `sk-nou-…` keys so clients authenticate against the proxy routes. Always required — an instance with no keys serves nobody.
- **Dashboard Accounts**: Username + password auth stored in SQLite — add users, change your own username and password, no external identity provider.

### Account Management
- **Hybrid Intelligent Routing**: Sticky by default (preserves prompt cache), auto-failover on rate limit/error.
- **Health Scoring & Cooldowns**: Health moves on a 0–100 scale shared by every provider; a spent quota cools the model, not the whole account. A 4xx caused by the *request* costs an account nothing, because every credential would refuse it identically.
- **Device Fingerprinting**: Standard client headers + CLI pool variant per account.

### Token Optimization
- **RTK (Tool Result Compression)**: Inline, zero-network compression of tool_result content (git diff, grep, file reads). Runs before Headroom.
- **Headroom Service**: External compression service for large payloads (optional, fail-safe).
- **Multi-Layer Signature Cache**: 4-layer LRU cache (tool, family, session, reasoning) for thinking signature continuity.

### Resilience
- **Cross-Provider Failover**: A bare model id is tried against each provider that serves it, in the order you registered them, until one answers. Only before the first byte reaches the client — a stream in flight is never retried.
- **Smart Retry with Delay Parsing**: Parses structured error payloads for retry delays, exponential backoff, max 5 attempts.
- **Per-Model Timeout**: Configurable timeout per model spec (default 60s) with AbortController.
- **JSON Schema Cleaning**: Strips unsupported fields for Gemini compatibility ($ref, anyOf, constraints).

### Intelligence
- **Thinking Budget Config**: Per-model thinking mode (budget/level), passthrough from client or model defaults.
- **Model Specs Registry**: Per-model maxOutputTokens, thinkingBudget, pool assignment, timeout — configurable via JSON overrides.
- **Configurable System Prompt**: Global system instruction injection, overridable via provider config without redeploy.
- **Caveman Mode**: Adjustable conciseness levels (1-5) prepended to system prompts.

### Smart routing

Send a model **without** a `provider:` prefix and the gateway picks. Candidates are every
provider that declares that exact model id *and* holds an account, tried in registration
order until one answers.

```bash
# Pinned: antigravity, or nothing.
curl … -d '{"model":"antigravity:claude-sonnet-4-6", …}'

# Routed: antigravity first, claudecode if it cannot serve the request.
curl … -d '{"model":"claude-sonnet-4-6", …}'
```

- A spent quota, dead credentials or an unreachable upstream **moves on**. A malformed
  body does not — every provider refuses it identically, so you get the real error instead
  of "all providers failed".
- Failover happens **before the first byte** only. Once a stream is flowing there is no
  taking it back.
- Matching is on the **exact** model id. `copilot:claude-opus-4.6` and
  `antigravity:claude-opus-4-6-thinking` are the same model to you and unrelated to the
  router; aliasing them needs a curated table, and guessing would silently route you to a
  different model.
- The dashboard's **API Playground** lists the routable ids under a *Smart Routing* filter,
  and every model row shows both forms with their own copy button.

**Custom providers join in automatically.** Routing walks the provider registry, and a custom
provider is a registry entry like any other — define one whose model id matches a built-in's
and a bare call fans out across both, no configuration. They are tried *after* the built-ins,
because `boot.ts` registers them last, so a custom provider is a fallback rather than a silent
replacement. Disabling one drops it from routing immediately, and a provider holding no API
keys is never a candidate.

### Observability
- **Real-time Dashboard**: Monitor accounts, quotas, cooldowns, health scores via React + daisyUI web UI.
- **Per-Provider Overview**: Traffic, spend, top models and account health for any provider, from the same metrics pipeline — plus a **Quota** tab for providers that report upstream limits.
- **Token & Cost Analytics**: Per-request token usage and estimated spend recorded to SQLite, charted by model, provider and client, with the savings compression *and* the prompt cache earned, plotted separately.
- **Live System Logs**: Console capture with level filtering, search, auto-scroll.

### Providers

Registration order is display order and bare-model routing order. Both are set in
`apps/backend/src/boot.ts`.

| Provider | Prefix | Auth | Quota reporting | Models |
|---|---|---|---|---|
| **Google Antigravity** | `antigravity:` | Google OAuth (multi-account) | Per-model rolling windows, averaged across the pool | Gemini 3.8 Flash (Low/Medium/High), Gemini 3 Flash, Gemini 3.5/3.1 Flash Lite, Gemini 3.1 Flash Image, Gemini 2.5 Pro, Claude Sonnet 4.6, Claude Opus 4.6 Thinking |
| **OpenAI Codex** | `codex:` | ChatGPT OAuth (PKCE, multi-account) | Primary/secondary windows and review quota from the `wham` API | GPT-6 Astra, GPT-5.6 Sol/Terra/Luna, GPT-5.5, GPT-5.4 (+ Mini), GPT-5.3 Codex Spark — each with a `-review` variant |
| **Claude Code** | `claudecode:` | Anthropic OAuth, or a pasted `setup-token` / API key | Five-hour and weekly plan windows from `/api/oauth/usage` | Claude Opus 5, Opus 4.8, Sonnet 5, Sonnet 4.6, Haiku 4.5, Fable 5.1 |
| **GitHub Copilot** | `copilot:` | GitHub Device Flow (multi-account) | Monthly chat / completions / premium-request entitlements per seat | Claude Sonnet 4.5, Claude Opus 4.5/4.6, Gemini 2.5 Pro, GPT-4o/4.1/5-mini |
| **Custom** | your own | Your own API keys (multi-key rotation) | — | Anything the upstream exposes — auto-discovered from its `/models` endpoint |

The Codex provider speaks OpenAI's **Responses** API upstream, not Chat Completions;
Nougate translates in both directions so your client never has to know.

Providers are plugins: each owns its auth, accounts, config and model registry, and
the core never branches on a provider's name. Features like quota reporting are
**capabilities** — a provider implements one optional method and the matching
dashboard tab appears, with no changes to the router or the UI. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), and `.claude/skills/nougate-contributing/` if you
are working on the code (or pointing an AI agent at it).

---

## Workspace Structure

```
├── apps/
│   ├── backend/                  # Bun API backend & routing gateway
│   │   └── src/
│   │       ├── core/             # contracts, registry, model resolver, paths,
│   │       │   ├── db/           #   Drizzle: dialect switch, schemas, DDL
│   │       │   ├── metrics/      #   usage logger, queries, pricing, rollups
│   │       │   └── mappers/      #   protocol translation shared by all providers
│   │       ├── protocols/        # openai/, anthropic/ — client-facing wire formats
│   │       ├── providers/        # antigravity/, codex/, claudecode/, copilot/,
│   │       │                     #   custom/ — isolated plugins
│   │       ├── auth/             # dashboard users, sessions, gateway API keys
│   │       ├── config/           # global config types & manager
│   │       ├── router/           # admin, metrics, api-keys, custom-providers, users
│   │       ├── boot.ts           # provider registration order = routing order
│   │       └── server.ts         # Bun.serve entry point
│   └── frontend/                 # React 19 SPA (Vite, TanStack Router, daisyUI)
├── data/                         # ALL runtime state — see "Where State Lives"
├── .claude/skills/               # contributor guides for AI coding agents
├── docs/                         # ARCHITECTURE.md, COMPARISON.md
├── screenshots/                  # dashboard images used by this README
├── config.example.json           # template for data/config.json (never read at runtime)
├── docker-compose.{dev,prod}.yml
├── Dockerfile
└── package.json                  # root workspace (Bun workspaces)
```

---

## Setup & Running

### Requirements
- [Bun](https://bun.sh) v1.0.0+

### Development
```bash
bun install

# Backend (http://localhost:3000)
bun run dev

# Frontend dev server (http://localhost:5173, proxies API)
bun run dev:frontend
```

To point frontend at remote backend:
```bash
VITE_BACKEND_URL=https://nougate.nouverse.tech bun run dev:frontend
```

### Production
```bash
bun run build:frontend
bun run start
```

### Docker
```bash
docker compose up -d --build
```

### Deploying an image

Every commit of `main` whose Test run passed is built and pushed as `ghcr.io/nouverse/nougate:<short SHA>` and
`latest` (`.github/workflows/docker-publish.yml`); nothing is built by hand, and no other branch is built. A host runs
a commit's tag, so what it runs is a commit that was tested, and going back is the previous commit's tag:

```bash
# beside docker-compose.prod.yml (as docker-compose.yml) and its .env
export NOUGATE_TAG=9109949
docker compose pull && docker compose up -d
```

Unset, `NOUGATE_TAG` is `latest`. Never run `docker compose config` there: it prints the environment.

---

## Where State Lives

**Every piece of runtime state lives in one directory** — `/app/data` in Docker, `./data`
locally — and there is exactly one path per file. No fallbacks, no per-launch-method
resolution, no seed copies inside the image. `bun run dev` (which runs from `apps/backend`),
`bun run start`, and Docker all read and write the same files.

```
data/
├── config.json                       # global gateway config
├── nougate.db                        # users, metrics, API keys, custom providers
├── signatures.json                   # thinking-signature cache (disposable)
├── .session-secret                   # cookie signing key (generated on first run)
└── providers/
    ├── antigravity/{accounts,config}.json
    └── copilot/{accounts,config}.json
```

### SQLite or Postgres

The database layer is [Drizzle ORM](https://orm.drizzle.team) over two schemas —
one SQLite, one Postgres — selected by `DB_URL`:

| `DB_URL` | Backend |
|---|---|
| *(empty)* | SQLite at `data/nougate.db` — no server needed, the default |
| `sqlite:/path/to/file.db` | SQLite at that path |
| `postgres://user:pass@host:5432/db` | Postgres |

Switching is config-only: tables are created on first boot for whichever backend
is selected, and no application code branches on it. The whole test suite runs
green against both.

Two things make that possible, and are worth knowing before editing the schema:

- **The two schemas must stay in step.** Drizzle types its tables per dialect, so
  `core/db/schema/sqlite.ts` and `core/db/schema/pg.ts` are the same tables
  written twice. Change one, change the other — `tests/unit/schema-parity.test.ts`
  fails the build if they diverge in tables, column names, nullability, defaults
  or JS types. Postgres deliberately stores epoch milliseconds as `bigint` and
  booleans as `0/1 integer`, so values round-trip identically and no call site
  has to know which database it is on.
- **Every query is written with `await`.** The SQLite driver is synchronous and
  the Postgres one is not; Drizzle's SQLite builders are also thenable, so
  awaiting everything is what lets one set of queries serve both.

The only fragment the dialects genuinely disagree on is bucketing a timestamp
into an hour or day label, which is isolated as `timeBucket()` in each schema
file.

Provider accounts and configs stay plain JSON so they remain easy to inspect, diff, and
hand-edit. They are written atomically (temp file + rename) and coalesced, so the OAuth
tokens they hold cannot be lost to a crash mid-write.

`config.example.json` is the template for `data/config.json`; it is documentation, never
read at runtime. Individual paths can be overridden with `NOUGATE_DB_PATH`, `CONFIG_FILE`,
`ACCOUNTS_FILE`, `COPILOT_ACCOUNTS_FILE`, `ANTIGRAVITY_CONFIG_FILE`, `COPILOT_CONFIG_FILE`,
or `SESSION_SECRET_FILE`.

> **Upgrading from a build before this change?** State used to resolve differently depending
> on how the process started, so you may have stray copies under `apps/backend/` or a
> repo-root `config.json`. Nothing reads them any more — move what you want into `data/` and
> delete the rest. A `nougate.db` from before the API-key metrics change must be deleted and
> recreated.

---

## Configuration

### Global Config (`data/config.json`)

```jsonc
{
  "bypassModelValidation": false,
  "rotation": {
    "strategy": "hybrid",  // hybrid | sticky | round-robin | least-used | random
    "cooldown": { "defaultDurationMs": 60000, "maxDurationMs": 3600000 }
  },
  "scoring": {
    "healthRange": { "min": 0, "max": 100, "initial": 100 },
    "penalties": { "apiError": -10, "refreshError": -20, "fatalError": -50, "systemicError": -5 },
    "rewards": { "success": 1 },
    "weights": { "health": 2.0, "lru": 0.1, "quota": 25 }  // quota: rank by remaining upstream headroom; 0 disables
  },
  "retry": { "maxAttempts": 5, "transientRetryThresholdSeconds": 5 },
  "tokens": { "expiryBufferMs": 60000 },
  "logging": { "maxBufferSize": 200, "enableConsoleCapture": true },
  "headroom": { "enabled": false, "url": "http://localhost:9999", "timeoutMs": 5000 },
  "caveman": { "enabled": false, "level": 3 },
  "rtk": { "enabled": true },
  "metrics": {
    "enabled": true,
    "detailRetentionDays": 14,   // per-request rows are pruned after this, rollups keep the trend
    "rollupRetentionDays": 90,
    "defaultInputPricePer1M": 0,     // 0 = off: an unpriceable model is reported "unpriced", not estimated
    "defaultOutputPricePer1M": 0
  }
}
```

> **The gateway's own URL is not in here.** It comes from `BASE_URL` alone, read
> through `core/base-url.ts`, and defaults to `http://localhost:${PORT}`. It
> decides where OAuth redirects land and whether session cookies carry `Secure` —
> deployment topology, settled before the container starts. It used to be stored
> here *as well*, which meant the dashboard offered a field the env var silently
> overwrote on the next boot. A `baseUrl` left in an existing `data/config.json`
> is ignored on read and dropped on the next save.

> **Global vs provider config.** `data/config.json` holds only settings that
> apply to the whole gateway. Anything that belongs to one provider — quota
> polling, feature flags, scheduling, model blacklist — lives in that provider's
> own file and is edited from its **Provider Config** tab, not from Global Config.

### Per-Provider Config (`data/providers/antigravity/config.json`)

```jsonc
{
  "features": {
    "keepThinking": false,
    "sanitizeToolNames": true,
    "googleSearchGrounding": false,
    "jitterEnabled": true,
    "jitterMinMs": 2000,
    "jitterMaxMs": 5000
  },
  "scheduling": {
    "mode": "cache_first",
    "maxCacheFirstWaitSeconds": 60,
    "maxRateLimitWaitSeconds": 30
  },
  "quota": { "refreshIntervalMs": 300000 },
  "systemInstruction": ""  // empty = use default, or override here
}
```

> **Upstream endpoints are not configurable.** They live in
> `providers/antigravity/upstream/endpoints.ts`, not in this file or the
> dashboard. They are not a preference: they are the hosts that speak the wire
> format the mappers produce, in the order the retry logic expects, so editing
> them could only ever break a working gateway. An `endpoints` block left in an
> older `config.json` is ignored on read and dropped on the next save. A
> different upstream that happens to be OpenAI- or Anthropic-shaped belongs in a
> **custom provider**, which exists precisely so a URL can be set from the UI.

Every provider keeps its own file under `data/providers/<id>/config.json`, and the keys
differ because the settings do. A few worth knowing:

| Provider | Key | What it does |
|---|---|---|
| `codex` | `cliVersion` | The Codex CLI version the gateway claims to be. The upstream **gates models on it** — newer models answer *"requires a newer version of Codex"* until it is raised |
| `claudecode` | `betaFeatures` | Replaces the default `anthropic-beta` gate list wholesale. A gate that graduates to GA is sometimes rejected as unknown, and waiting for a release to drop one is not an option |
| `claudecode` | `adaptToolNames` / `toolNameSuffix` | Suffixes client tool names so they cannot collide with reserved names. Off is for diagnosing whether a tool problem is this mechanic's fault |
| `claudecode` | `refreshCommand` | A command that prints a fresh OAuth access token. Empty by default, deliberately: shelling out to an arbitrary string is a capability, not a convenience |

### Model Spec Overrides (`data/providers/antigravity/model-specs.json`)

Override or add models at runtime without code changes:
```jsonc
{
  "gemini-3.8-flash-medium": {
    "maxOutputTokens": 32000
  }
}
```

### Environment Variables

```env
PORT=3000
BASE_URL=https://nougate.nouverse.tech
HEADROOM_URL=http://headroom:9999
DB_URL=                             # empty = SQLite at data/nougate.db; or postgres://...
NOUGATE_DB_PATH=./data/nougate.db   # SQLite file location (auto-resolved; rarely needed)
DEFAULT_INPUT_PRICE_1M=0            # blanket price fallback; 0 = off, models stay "unpriced"
DEFAULT_OUTPUT_PRICE_1M=0

# The first dashboard account, created only while the user table is empty.
# No fallback: leave either blank and nobody can sign in at all.
INITIAL_ADMIN_USERNAME=operator
INITIAL_ADMIN_PASSWORD=<at least 8 characters>

# Pod limits. Both are unset by default, and unset means "not enforced" — neither
# has a built-in value that would silently change how an existing deployment behaves.
BOTTOM_JITTER=                      # ms; minimum delay before ANY provider's request
                                    # goes upstream. Raises a provider's own window and
                                    # overrides a provider that turned jitter off.
                                    # BOTTOM_JITTER_MS is accepted as an alias.
MAX_ACCOUNT_MULTIPLEXING=           # hard cap on accounts per provider. Adding one
                                    # past it is refused (409) on every add path;
                                    # the dashboard shows "3 / 5" per provider.

# Dashboard sessions. Optional — one is generated into data/.session-secret on
# first run if unset. Set it to keep sessions valid across a wiped data volume.
SESSION_SECRET=<openssl rand -base64 32>
SESSION_TTL_HOURS=168
```

> Dashboard sign-in is username + password stored in the database. There are no
> `GOOGLE_CLIENT_*` variables — Google OAuth was removed as a dashboard login and
> is now only what the *Antigravity provider* uses to add its own accounts.

### Dashboard Authentication (username + password)

The dashboard and the `/api/*` admin endpoints are **always** protected — there is
no switch that turns this off. Accounts live in the SQLite database, so no config
file or external identity provider is involved.

The LLM proxy routes (`/openai/v1/*`, `/anthropic/v1/*`) are deliberately *not*
covered here: CLI clients cannot hold a browser session, so they are guarded
separately by [gateway API keys](#gateway-api-keys).

**First run.** When the database has no users, the first account is created from
two environment variables:

```env
INITIAL_ADMIN_USERNAME=operator
INITIAL_ADMIN_PASSWORD=<something long>
```

**There is no fallback.** If either is missing or blank, no account is created
and *nobody can sign in* — the startup log says so in a box. A gateway that ships
with a working username and password is a gateway anyone who read its README can
open, and "you were supposed to change it" has never made that untrue.

The password is taken exactly as given: no length rule, no character rule. The
policy that guards the dashboard's own forms exists to stop users picking
something weak; this value is set by whoever runs the deployment, in a file only
they can write. The **username** is still checked (3–254 characters, no spaces),
because one with a space cannot be typed back exactly — that would create an
account nobody could sign in to, which is a different kind of mistake.

The account is not flagged for a forced password change: you chose the password,
so being made to change it immediately would be theatre. That flag still exists,
and still applies to accounts an admin creates for other people.

Both variables are read **only while the user table is empty**. Setting them on a
deployment that already has users does nothing — they bootstrap an account, they
do not reset one. Lost the password? Sign in as another admin and reset it from
**User Management**, or delete the user rows and restart.

Two pages, deliberately separate:

**Account Settings** — your own sign-in details:

- Change your username (you sign in with the new one from then on).
- Change your password.

Both require your current password, so an unattended browser tab is not enough
to take the account over. The one exception is the first-run setup screen: that
session was minted seconds earlier by proving the very credential being
replaced, and the account can reach nothing else until it completes, so it only
asks for the new password.

**Users** — everyone else's accounts:

- Add a user with a temporary password; they are required to replace it on first
  sign-in, so you never end up knowing their real password.
- Reset someone else's password.
- Delete a user — which revokes their open sessions on the next request.

Every user is an administrator; there are no roles.

Notes:

- **Passwords are hashed with argon2id** via `Bun.password`, never stored or
  logged in plain text.
- **Sessions are stateless HMAC-signed cookies** (`HttpOnly`, `SameSite=Lax`,
  `Secure` when `BASE_URL` is https). If `SESSION_SECRET` is unset, one is
  generated on first use and stored at `data/.session-secret`, so sessions
  survive restarts. Set `SESSION_TTL_HOURS` to change the 7-day default.
- **Failed sign-ins are throttled** per username: five failures trigger a
  60-second lockout, and one account being hammered never locks out the others.
- **Wrong password and unknown username return the identical response**, so the
  login form cannot be used to enumerate accounts.
- The signed-in user is re-read from the database on every request, so deleting
  an account takes effect immediately rather than when its cookie expires.
- The last remaining user cannot be deleted, and you cannot delete the account
  you are signed in with — there is no way to lock yourself out.

> Serve the dashboard over HTTPS in production. A password crosses the network on
> every sign-in, and the session cookie only gets its `Secure` flag when
> `BASE_URL` starts with `https://`.

---

## Custom Providers

Point Nougate at any OpenAI- or Anthropic-compatible endpoint from the **Custom Providers**
page in the dashboard. You choose the provider ID, and that ID becomes the model prefix.

Adding `deepseek` with base URL `https://api.deepseek.com/v1` and the OpenAI API style makes
its models callable immediately:

```bash
curl https://nougate.nouverse.tech/openai/v1/chat/completions \
  -H "Authorization: Bearer sk-nou-..." \
  -d '{"model": "deepseek:deepseek-v4-flash", "messages": [{"role":"user","content":"hi"}]}'
```

What a custom provider carries:

- **API style** — `openai` (`/chat/completions`, `Authorization: Bearer`) or `anthropic`
  (`/messages`, `x-api-key` + `anthropic-version`). Nougate translates between the client's
  protocol and the upstream's style in both directions, so an Anthropic client can call an
  OpenAI-style upstream and vice versa.
- **Multiple API keys** — keys behave like accounts: health-scored, least-recently-used
  rotation, automatic cooldown on `429`/`503`, and failover to the next key mid-request.
  They appear in the provider's own **Accounts** tab too, with the same reset and
  cooldown controls the built-in providers get.
- **Models** — press *Auto-load from upstream* to import everything the upstream's `/models`
  endpoint reports. Re-syncing adds new models and never overwrites prices or overrides you
  edited by hand. Models can also be added one at a time. Switch a model **off** in its row to
  stop serving it and keep it out of later auto-loads; a removed model comes back with the next
  one. Through the API, a save changes only the fields it states (`null` clears one).
- **Pricing** — per-model `$/1M` input and output rates feed the cost dashboard, editable in
  the provider's Models table. Leave a rate on `auto` and the built-in price book works it out
  from the model name, which handles aggregator IDs like `anthropic/claude-opus-4.5` correctly.
  A model nothing can price is marked **unpriced** and counts as $0 rather than being given an
  invented rate — set a number when you want it included in spend.
- **Extra headers** — merged into every upstream request, for gateways that need them.

Provider IDs must be lowercase (`[a-z][a-z0-9_-]*`) and cannot collide with a built-in
provider. Disabling a provider unregisters its prefix without deleting its keys or models.

---

## API Playground

The **API Playground** page sends a real request through the gateway — the same routes, auth
and metrics pipeline your clients hit, not a simulation.

- Pick any model from the full catalogue. **All providers** lists every model bare, one row
  each; **Smart Routing** narrows to the ones more than one provider can serve; picking a
  single provider switches to the `provider:model` form.
- Switch between the OpenAI and Anthropic protocol to check both translations.
- Toggle streaming to watch tokens arrive live, or turn it off for a single JSON response.
- See status, latency, input/output tokens and estimated cost after each run.
- Copy the equivalent `curl` command, ready to paste into a terminal or a teammate's chat.

**Choose which key to bill, not which key to paste.** Gateway keys are stored hashed, so
nothing can hand a signed-in operator the secret back — which used to mean minting a
throwaway key just to try a prompt. The Playground instead picks a key from a dropdown: your
dashboard session authorises the call, and the key you chose is what the usage is attributed
to. The `curl` snippet still shows `sk-nou-...`, because a terminal has no session and does
need the real secret.

---

## Token Usage & Cost Monitoring

Every request through the gateway is recorded to SQLite (`data/nougate.db`, or
`/app/data/nougate.db` in Docker) and charted on the **Token Metrics** page.

- **Non-blocking** — rows are buffered in memory and batch-written on one heartbeat — every 5 s
  on its own, every 30 s inside a host such as Nouride, where the database shares an SD card — so
  a slow or locked database can never stall an in-flight LLM response.
- **Real usage when available** — token counts come from the upstream's `usage` block for
  both streamed and non-streamed responses. When a provider reports nothing, counts are
  estimated from payload size and the row is flagged `est` in the dashboard.
- **Compression ROI, per engine** — the payload is measured *between* passes, not just at
  each end, so each engine's contribution is recorded separately. The dashboard's **Savings
  by engine** panel shows what RTK removed versus what Headroom removed, how many requests
  each ran on, and what those tokens were worth. An engine that is enabled but found nothing
  to compress is reported at zero, which is a different fact from being switched off — that
  is how you notice a filter that has stopped matching. Per-engine detail lives in the
  detail log, so it covers the 14-day retention window; longer windows are served from the
  rollups and report the combined total only, and say so rather than showing an empty chart.
- **Cost estimation** — spend is computed at upstream *list* prices. For subscription-based
  providers like Copilot and Antigravity this is the value routed through the gateway, not
  what you were billed. Price resolution: the model's own rate → the built-in price book
  matched on model family → an optional blanket rate
  (`metrics.defaultInputPricePer1M`/`defaultOutputPricePer1M`, off by default). If none apply
  the model is reported as **unpriced** at $0 and flagged in the dashboard; its tokens are
  still recorded. A guessed rate is indistinguishable from a real one on a chart, so nothing
  is invented silently.
- **Retention, two tiers** — `token_usage_logs` holds one row per request; an hourly job
  folds finished days into `token_usage_daily_rollups` (one row per day × model × client ×
  API key) *before* pruning, so nothing is lost from the aggregate. Detail rows are pruned
  past `detailRetentionDays` (14), rollups past `rollupRetentionDays` (90). The dashboard
  reads whichever table covers the window, and the switchover point **is**
  `detailRetentionDays` — raise it and longer windows start being served from the detail
  log automatically. Past the detail window you keep every total (requests, tokens, cost,
  savings, sliced per day/model/provider/client/key) and lose only per-request facts:
  exact timestamps, latency, status codes, per-engine compression detail, and row-level
  CSV export. Detail grows linearly with traffic; rollups plateau, which is the whole
  point of the split.
- **Attribution** — usage is grouped by both **client** and **gateway API key**, and either
  can be used as a filter (they compose). The client ID comes from the `x-client-id` header,
  else the name of the key used, else `unknown`; the key is recorded separately, so naming a
  key per machine or per agent gives you per-machine spend even when clients set their own
  `x-client-id`. Historical traffic from before keys were required appears as **no key**, and
  a key that was deleted still shows its usage as **deleted key**. Because the client ID falls
  back to the key's name, the per-client and per-key breakdowns are identical until some caller
  actually sends `x-client-id` — the dashboard collapses them to one panel while that is true,
  rather than showing the same numbers twice. The API key is stored in
  the daily rollups too, so the filter works across the full 90-day window, not just the
  detail-log retention period.

Set `metrics.enabled` to `false` to turn recording off entirely.

---

## Gateway API Keys

Issue `sk-nou-…` keys on the **API Keys** page so clients authenticate against the proxy
routes. Only a SHA-256 hash is stored — the full key is shown exactly once, at creation.

**Keys are always required.** `/openai/v1/*` and `/anthropic/v1/*` reject any request
without a valid key, in the error shape that protocol expects. There is no setting that
turns this off, and a fresh instance with no keys yet rejects everything — "no keys
configured" fails closed rather than being read as "no key needed". Create a key before
pointing clients at the gateway.

Both header conventions are accepted, so no client needs special handling:

```bash
# OpenAI-style clients
curl https://nougate.nouverse.tech/openai/v1/chat/completions \
  -H "Authorization: Bearer sk-nou-xxxxxxxx" \
  -d '{"model": "deepseek:deepseek-v4-flash", "messages": [...]}'

# Anthropic-style clients
curl https://nougate.nouverse.tech/anthropic/v1/messages \
  -H "x-api-key: sk-nou-xxxxxxxx" \
  -d '{"model": "deepseek:deepseek-v4-flash", "max_tokens": 1024, "messages": [...]}'
```

Keys can be given an expiry, revoked (keeping their usage history) or deleted outright. The
key's name doubles as the client ID in cost reports, so naming keys per machine or per agent
gives you per-client spend for free.

**Note:** this guards the LLM proxy routes. The dashboard and `/api/*` are guarded separately
by username + password — see *Dashboard Authentication* above.

---

## APIs

All models follow `provider:model-id` format.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/openai/v1/models` | GET | List available models across every provider (OpenAI format) |
| `/openai/v1/chat/completions` | POST | Chat completions (OpenAI protocol) |
| `/anthropic/v1/models` | GET | List available models across every provider (Anthropic format) |
| `/anthropic/v1/messages` | POST | Messages (Anthropic protocol) |

Every response a provider gave — an answer, or the failure handed back when all of them failed — says who
served it:

| Header | Value |
|--------|-------|
| `x-nougate-provider` | The provider that served, e.g. `antigravity` |
| `x-nougate-model` | The model as that provider names it, e.g. `claude-sonnet-4-6` |
| `x-nougate-attempts` | Providers tried for this request, the one that served included: `1` unless it failed over |
| `x-nougate-tried` | Which they were, in order: `antigravity,claudecode` |

When no provider answered at all — each one threw — the error response (a 502, or the status the last provider's
error names, with its `Retry-After`) still carries `x-nougate-attempts` and `x-nougate-tried`, so "every provider
failed" says which ones.

A bare model id can be served by any provider that declares it, the next taking over when one fails, and the
body's `model` does not say which did on every provider — so a client that keeps its own accounting reads these.
Browsers may read them too (`Access-Control-Expose-Headers`). Retries inside one provider, across its accounts,
are that provider's own header: `X-Antigravity-Attempts`, `X-Copilot-Attempts`, `X-Claude-Code-Attempts`,
`X-Kiro-Attempts`, and `X-Custom-Attempts` on a custom provider's stream.

Admin endpoints (behind the dashboard guard):

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/providers` | GET | Every registered provider with account and model counts |
| `/api/providers/:id` | GET | One provider: config, models, accounts, `capabilities`, `quotas` |
| `/api/providers/:id/config` | POST | Update that provider's own config |
| `/api/providers/:id/accounts/add` | POST | Start or complete this provider's account flow |
| `/api/models` | GET | Full catalogue of callable `provider:model` IDs with resolved pricing |
| `/api/metrics/token-usage` | GET | Summary, time series, per-model/provider/client/API-key breakdowns, and per-compression-engine savings. Query: `lookback`, `clientId`, `provider`, `apiKeyId` |
| `/api/metrics/recent` | GET | Most recent individual requests |
| `/api/metrics/export` | GET | CSV export of the detail log for the selected window |
| `/api/metrics/maintenance` | POST | Run rollup + pruning immediately |
| `/api/api-keys` | GET / POST | List keys, or mint a new one |
| `/api/api-keys/:id/revoke` | POST | Revoke a key |
| `/api/api-keys/:id` | DELETE | Delete a key |
| `/api/custom-providers` | GET / POST | List or create custom providers |
| `/api/custom-providers/:id` | GET / POST / DELETE | Read, update, or delete one |
| `/api/custom-providers/:id/keys` | GET / POST | List or add upstream API keys |
| `/api/custom-providers/:id/keys/:keyId` | DELETE | Remove an upstream API key |
| `/api/custom-providers/:id/models` | GET / POST | List or upsert model definitions |
| `/api/custom-providers/:id/models/:modelId` | DELETE | Remove a model |
| `/api/custom-providers/:id/sync-models` | POST | Auto-discover models from the upstream |

Dashboard authentication endpoints (always active):

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/auth/me` | GET | Current session, or 401 when signed out |
| `/api/auth/login` | POST | Exchange `{username, password}` for a session cookie |
| `/api/auth/profile` | POST | Change your own username and/or password |
| `/api/auth/logout` | POST | Expire the session cookie |
| `/api/users` | GET / POST | List users, or create one |
| `/api/users/:id` | DELETE | Delete a user |
| `/api/users/:id/password` | POST | Reset another user's password |

---

## Integration Guides

### Zed Editor

In `~/.config/zed/settings.json`:
```jsonc
{
  "language_models": {
    "anthropic_compatible": {
      "nougate": {
        "api_url": "https://nougate.nouverse.tech/anthropic",
        "available_models": [
          {
            "name": "antigravity:gemini-3.8-flash-medium",
            "display_name": "(Nougate) Gemini 3.5 Flash Medium",
            "max_tokens": 1048576,
            "max_output_tokens": 64000,
            "capabilities": { "prompt_caching": false, "tools": true, "images": true }
          }
        ]
      }
    }
  },
  "agent": {
    "default_model": {
      "provider": "nougate",
      "model": "copilot:claude-opus-4.6"
    }
  }
}
```

### Claude Code CLI

```bash
export ANTHROPIC_BASE_URL="https://nougate.nouverse.tech/anthropic"
claude --model antigravity:claude-sonnet-4-6
```

### OpenCode

```jsonc
{
  "provider": {
    "nougate": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "https://nougate.nouverse.tech/openai/v1" },
      "models": {
        "antigravity:gemini-3.8-flash-medium": {
          "name": "Gemini 3.5 Flash Medium",
          "limit": { "context": 1048576, "output": 65535 }
        }
      }
    }
  }
}
```

### Generic OpenAI-Compatible Client

```bash
curl https://nougate.nouverse.tech/openai/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "antigravity:gemini-3.8-flash-medium",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": true
  }'
```

---

## Account Management

### Antigravity (Google OAuth)
1. Navigate to dashboard → Providers → Antigravity
2. Click "Add Account" → OAuth flow opens in browser
3. Accounts auto-discover project ID and start quota polling

### Codex (ChatGPT OAuth)
1. Navigate to dashboard → Providers → OpenAI Codex
2. Click "Add Account" → open the authorization link in a new tab
3. OpenAI redirects to `http://localhost:1455/auth/callback`, a port this gateway does not
   listen on, so the tab fails to load — that is expected. Copy its full URL and paste it back

> Codex gates models on the CLI version it is told about. `cliVersion` in the provider
> config is what the gateway claims to be; models refused with *"requires a newer version of
> Codex"* need it raised, not a different plan.

### Claude Code (Anthropic OAuth)
1. Navigate to dashboard → Providers → Claude Code
2. Click "Add Account" → open the authorization link in a new tab
3. Approving lands back on this gateway, which finishes the exchange and closes the dialog.
   If that tab cannot reach the gateway, paste its URL — or the `code#state` value — instead

A pasted `claude setup-token` or a plain `sk-ant-…` API key also works; only an OAuth
account can renew itself.

### Copilot (GitHub Device Flow)
1. Navigate to dashboard → Providers → GitHub Copilot
2. Click "Add Account" → Device code displayed
3. Enter code at github.com/login/device → token auto-exchanges

### Custom Provider (API keys)
1. Dashboard → Custom Providers → **New provider**
2. Give it an ID (that ID becomes the model prefix), base URL and API style
3. Add one or more keys — they rotate like accounts, with health scores and cooldowns
4. **Auto-load from upstream** to import the models it exposes

### Tier bonus (Antigravity only)

An Antigravity account may carry a `tier`, which adds a bonus to its rotation score:
**ultra** +30, **pro** +15, **free** none.

> Nothing sets it automatically. The auto-detection and the admin override were both removed
> as unreachable code — they had no callers — so `tier` is read by the scorer and written only
> by editing `data/providers/antigravity/accounts.json` by hand. Left in rather than deleted
> because the scoring half still works; wire a setter back up if you want it live.

Every other provider ranks purely on health score with least-recently-used as the tie-break.
Claude Code and Codex first send a conversation back to the account that answered it last,
while that account can answer: their upstreams cache a conversation per account.

---

## Documentation

| Document | What it covers |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Planes, request pipeline, contracts, the capability model, persistence, known gaps |
| [docs/COMPARISON.md](docs/COMPARISON.md) | Rated comparison against 9Router and OmniRoute across architecture, features and scalability — including where Nougate loses |
| `.claude/skills/nougate-contributing/` | Working guide: invariants, adding a provider, the data layer, frontend conventions, and the mistakes already made here |

Two documents, on purpose. Design notes that described work in progress were deleted
rather than left to rot — a stale document is worse than an absent one, because it is
quoted with confidence.

---

## License

Internal use only — Nouverse.
