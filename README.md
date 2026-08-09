# Nougate

> Route any LLM provider through any protocol. One gateway, isolated providers, strict model namespacing.

**Nougate** is Nouverse's internal LLM gateway — a modular router that sits between your tools and AI providers. Route requests through OpenAI or Anthropic protocols, authenticate via isolated per-provider accounts, and address any model unambiguously with `provider:model-id` namespacing.

---

## Features

### Core
- **Multi-Protocol**: Expose providers via OpenAI (`/openai/v1/`) and Anthropic (`/anthropic/v1/`) compatible APIs simultaneously.
- **Multi-Provider**: Pluggable provider system — each provider owns its auth, accounts, config, and model registry.
- **Strict Model Namespacing**: All models use `provider:model-id` format (e.g. `antigravity:gemini-3.5-flash-low`, `copilot:claude-opus-4.6`).
- **Per-Provider Auth Isolation**: Credentials and account storage are fully isolated per provider.
- **Custom Providers**: Define your own upstream from the dashboard — pick an ID, base URL, OpenAI or Anthropic API style, keys and pricing, then call it as `{provider_id}:{model}`.
- **Gateway API Keys**: Issue `sk-nou-…` keys so clients authenticate against the proxy routes. Off by default; one toggle turns it on.
- **Dashboard Accounts**: Username + password auth stored in SQLite — add users, change your own username and password, no external identity provider.

### Account Management
- **Hybrid Intelligent Routing**: Sticky by default (preserves prompt cache), auto-failover on rate limit/error.
- **Health Scoring & Cooldowns**: Penalizes on errors, applies family-level cooldowns on quota exhaustion.
- **Tiered Account Sorting**: Accounts classified as Ultra/Pro/Free (auto-detected from quota). Higher tiers get priority in fallback selection.
- **Device Fingerprinting**: Full impersonation headers + CLI pool variant per account.

### Token Optimization
- **RTK (Tool Result Compression)**: Inline, zero-network compression of tool_result content (git diff, grep, file reads). Runs before Headroom.
- **Headroom Service**: External compression service for large payloads (optional, fail-safe).
- **Multi-Layer Signature Cache**: 4-layer LRU cache (tool, family, session, reasoning) for thinking signature continuity.

### Resilience
- **Smart Retry with Delay Parsing**: Parses structured error payloads for retry delays, exponential backoff, max 5 attempts.
- **Per-Model Timeout**: Configurable timeout per model spec (default 60s) with AbortController.
- **JSON Schema Cleaning**: Strips unsupported fields for Gemini compatibility ($ref, anyOf, constraints).

### Intelligence
- **Thinking Budget Config**: Per-model thinking mode (budget/level), passthrough from client or model defaults.
- **Model Specs Registry**: Per-model maxOutputTokens, thinkingBudget, pool assignment, timeout — configurable via JSON overrides.
- **Configurable System Prompt**: Global system instruction injection, overridable via provider config without redeploy.
- **Caveman Mode**: Adjustable conciseness levels (1-5) prepended to system prompts.

### Observability
- **Real-time Dashboard**: Monitor accounts, quotas, cooldowns, health scores via React + daisyUI web UI.
- **Token & Cost Analytics**: Per-request token usage and estimated spend recorded to SQLite, charted by model, provider and client, with the savings compression earned.
- **Live System Logs**: Console capture with level filtering, search, auto-scroll.
- **Debug Payload Logger**: Dump request/response JSON to disk (configurable, model-filterable, fail-safe).

### Providers

| Provider | Auth | Models |
|----------|------|--------|
| **Antigravity** | Google OAuth (multi-account) | Gemini 3/3.1/3.5 Flash, Gemini 3.1 Pro, Claude Sonnet/Opus 4.6 via Gemini |
| **Copilot** | GitHub Device Flow (multi-account) | Claude Sonnet 4.5, Claude Opus 4.5/4.6, Gemini 2.5 Pro, GPT-4o/4.1/5-mini |
| **Custom** | Your own API keys (multi-key rotation) | Anything the upstream exposes — auto-discovered from its `/models` endpoint |

---

## Workspace Structure

```
├── apps/
│   ├── backend/          # Bun API backend & routing gateway
│   │   ├── src/
│   │   │   ├── core/        # RTK, compressor, signature cache, debug logger
│   │   │   ├── protocols/   # OpenAI & Anthropic protocol handlers
│   │   │   ├── providers/   # antigravity/, copilot/ (isolated)
│   │   │   ├── config/      # Global config types & manager
│   │   │   └── router/      # Admin API & SSE events
│   │   └── package.json
│   └── frontend/         # React SPA dashboard (Vite + TanStack Router)
│       ├── src/
│       └── package.json
├── providers/            # Runtime config & account storage (per-provider)
│   ├── antigravity/
│   └── copilot/
├── config.json           # Global gateway configuration
├── docker-compose.yml    # Docker services orchestration
├── Dockerfile            # Multi-stage production build
└── package.json          # Root workspace (Bun workspaces)
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

---

## Where State Lives

All runtime state is anchored to the **project root**, never to the current working
directory — so `bun run dev` (which runs from `apps/backend`), `bun run start`, and Docker
(which runs from `/app`) all read and write the same files.

| What | Docker | Local |
|------|--------|-------|
| Dashboard users, metrics, gateway API keys, custom providers | `/app/data/nougate.db` | `./data/nougate.db` |
| Provider accounts | `/app/data/providers/<id>/accounts.json` | `./data/providers/<id>/accounts.json` |
| Provider config | `/app/data/providers/<id>/config.json` | `./data/providers/<id>/config.json` |
| Global config | `/app/data/config.json` | `./config.json` |
| Session signing secret | `/app/data/.session-secret` | `./data/.session-secret` |

Only the SQLite database is new — provider accounts and configs stay plain JSON so they
remain easy to inspect, diff, and hand-edit.

Override with `NOUGATE_DB_PATH`, `CONFIG_FILE`, `ACCOUNTS_FILE`, `COPILOT_ACCOUNTS_FILE`,
`ANTIGRAVITY_CONFIG_FILE`, `COPILOT_CONFIG_FILE`, or `SESSION_SECRET_FILE`.

> **Upgrading from an earlier build?** Paths used to be derived from the working directory,
> so starting the server two different ways produced two separate sets of state. On boot the
> gateway now logs the file it actually loaded and warns about any stray copy it is ignoring
> — check the startup output and delete the leftovers (typically under `apps/backend/`).

---

## Configuration

### Global Config (`config.json`)

```jsonc
{
  "baseUrl": "http://localhost:3000",
  "bypassModelValidation": false,
  "rotation": {
    "strategy": "hybrid",  // hybrid | sticky | round-robin | least-used | random
    "cooldown": { "defaultDurationMs": 60000, "maxDurationMs": 3600000 }
  },
  "scoring": {
    "healthRange": { "min": 0, "max": 100, "initial": 100 },
    "penalties": { "apiError": -10, "refreshError": -20, "fatalError": -50, "systemicError": -5 },
    "rewards": { "success": 1 },
    "weights": { "health": 2.0, "lru": 0.1 }
  },
  "retry": { "maxAttempts": 5, "transientRetryThresholdSeconds": 5 },
  "tokens": { "expiryBufferMs": 60000 },
  "logging": { "maxBufferSize": 200, "enableConsoleCapture": true },
  "headroom": { "enabled": false, "url": "http://localhost:9999", "timeoutMs": 5000 },
  "caveman": { "enabled": false, "level": 3 },
  "rtk": { "enabled": true },
  "debugLogger": { "enabled": false, "outputDir": "./tmp/debug-payloads", "modelFilter": [] },
  "metrics": {
    "enabled": true,
    "detailRetentionDays": 14,   // per-request rows are pruned after this, rollups keep the trend
    "rollupRetentionDays": 90,
    "defaultInputPricePer1M": 2.5,   // used only when a model has no price and no price-book match
    "defaultOutputPricePer1M": 10
  },
  "apiKeys": { "enabled": false }  // true = /openai/v1/* and /anthropic/v1/* require a gateway key
}
```

*`BASE_URL` env var overrides `baseUrl`. Required for OAuth redirect routing.*

### Per-Provider Config (`providers/antigravity/config.json`)

```jsonc
{
  "endpoints": {
    "sandbox": ["https://us-central1-cloudaicompanion-pa.cloud.google.com"],
    "cli": ["https://cloudaicompanion-pa.googleapis.com"]
  },
  "features": {
    "keepThinking": false,
    "sanitizeToolNames": true,
    "googleSearchGrounding": false,
    "jitterEnabled": true,
    "jitterMinMs": 100,
    "jitterMaxMs": 500
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

### Model Spec Overrides (`providers/antigravity/model-specs.json`)

Override or add models at runtime without code changes:
```jsonc
{
  "gemini-3.5-flash-low": {
    "maxOutputTokens": 64000,
    "thinkingMode": "level",
    "thinkingLevel": "medium"
  }
}
```

### Environment Variables

```env
PORT=3000
BASE_URL=https://nougate.nouverse.tech
HEADROOM_URL=http://headroom:9999
NOUGATE_DB_PATH=./data/nougate.db   # metrics, API keys, custom providers (auto-resolved)
DEFAULT_INPUT_PRICE_1M=2.5          # cost fallback for models with no known price
DEFAULT_OUTPUT_PRICE_1M=10

# Dashboard authentication (all three required to activate it)
GOOGLE_CLIENT_ID=xxxxxxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=xxxxxxxx
SESSION_SECRET=<openssl rand -base64 32>
```

### Dashboard Authentication (username + password)

The dashboard and the `/api/*` admin endpoints are **always** protected — there is
no switch that turns this off. Accounts live in the SQLite database, so no config
file or external identity provider is involved.

The LLM proxy routes (`/openai/v1/*`, `/anthropic/v1/*`) are deliberately *not*
covered here: CLI clients cannot hold a browser session, so they are guarded
separately by [gateway API keys](#gateway-api-keys).

**First run.** When the database has no users, an account is seeded:

```
username: admin
password: admin123
```

That credential is flagged for mandatory replacement. It unlocks exactly one
screen — "finish setting up your account" — and every other endpoint answers
`403 password_change_required` until a real password is set. So the well-known
default never grants access to a publicly reachable gateway, even if you forget
to change it right away. That screen also lets you claim a real **username**
instead of `admin`, which is optional and can be done later.

Two pages, deliberately separate:

**Account Settings** — your own sign-in details:

- Change your username (you sign in with the new one from then on).
- Change your password.

Both require your current password, so an unattended browser tab is not enough
to take the account over.

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
- **Models** — press *Auto-load from upstream* to import everything the upstream's `/models`
  endpoint reports. Re-syncing adds new models and never overwrites prices or overrides you
  edited by hand. Models can also be added one at a time.
- **Pricing** — per-model `$/1M` input and output rates feed the cost dashboard. Leave them
  empty to fall back to the built-in price book, then the configured flat default.
- **Extra headers** — merged into every upstream request, for gateways that need them.

Provider IDs must be lowercase (`[a-z][a-z0-9_-]*`) and cannot collide with a built-in
provider. Disabling a provider unregisters its prefix without deleting its keys or models.

---

## API Playground

The **API Playground** page sends a real request through the gateway — the same routes, auth
and metrics pipeline your clients hit, not a simulation.

- Pick any model from the full catalogue (all providers, already prefixed) with a filter box.
- Switch between the OpenAI and Anthropic protocol to check both translations.
- Toggle streaming to watch tokens arrive live, or turn it off for a single JSON response.
- See status, latency, input/output tokens and estimated cost after each run.
- Copy the equivalent `curl` command, ready to paste into a terminal or a teammate's chat.

When key enforcement is on, paste a gateway key into the playground's key field — the
playground is deliberately subject to the same check as any other client.

---

## Token Usage & Cost Monitoring

Every request through the gateway is recorded to SQLite (`data/nougate.db`, or
`/app/data/nougate.db` in Docker) and charted on the **Token Metrics** page.

- **Non-blocking** — rows are buffered in memory and batch-written every 5s, so a slow or
  locked database can never stall an in-flight LLM response.
- **Real usage when available** — token counts come from the upstream's `usage` block for
  both streamed and non-streamed responses. When a provider reports nothing, counts are
  estimated from payload size and the row is flagged `est` in the dashboard.
- **Compression ROI** — the token delta across RTK and Headroom is recorded per request, so
  the dashboard shows what compression actually saved in dollars.
- **Cost estimation** — spend is computed at upstream *list* prices. For subscription-based
  providers like Copilot and Antigravity this is the value routed through the gateway, not
  what you were billed. Price resolution: the model spec's own prices → the built-in price
  book matched on model family → `metrics.defaultInputPricePer1M`/`defaultOutputPricePer1M`.
- **Retention** — an hourly job rolls per-request rows into daily aggregates, prunes detail
  rows past `detailRetentionDays` (14), and prunes rollups past `rollupRetentionDays` (90).
  Windows longer than 14 days are served from the rollup table, so the dashboard stays fast.
- **Attribution** — usage is grouped by client. The client ID comes from the `x-client-id`
  header, else the name of the gateway API key used, else `unknown`.

Set `metrics.enabled` to `false` to turn recording off entirely.

---

## Gateway API Keys

Issue `sk-nou-…` keys on the **API Keys** page so clients authenticate against the proxy
routes. Only a SHA-256 hash is stored — the full key is shown exactly once, at creation.

Enforcement is off by default so existing deployments keep working after an upgrade. Create
a key, point your clients at it, then flip the **Required** toggle (or set
`apiKeys.enabled: true`). Once on, `/openai/v1/*` and `/anthropic/v1/*` reject any request
without a valid key, in the error shape that protocol expects.

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

Admin endpoints (behind the dashboard guard):

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/models` | GET | Full catalogue of callable `provider:model` IDs with resolved pricing |
| `/api/metrics/token-usage` | GET | Summary, time series, and per-model/provider/client breakdowns. Query: `lookback`, `clientId`, `provider` |
| `/api/metrics/recent` | GET | Most recent individual requests |
| `/api/metrics/export` | GET | CSV export of the detail log for the selected window |
| `/api/metrics/maintenance` | POST | Run rollup + pruning immediately |
| `/api/api-keys` | GET / POST | List keys, or mint a new one |
| `/api/api-keys/settings` | POST | Toggle key enforcement |
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
            "name": "antigravity:gemini-3.5-flash-low",
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
        "antigravity:gemini-3.5-flash-low": {
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
    "model": "antigravity:gemini-3.5-flash-low",
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

### Copilot (GitHub Device Flow)
1. Navigate to dashboard → Providers → Copilot
2. Click "Add Account" → Device code displayed
3. Enter code at github.com/login/device → token auto-exchanges

### Tier System
Accounts are automatically classified based on quota remaining:
- **Ultra**: All quotas > 70% remaining (priority +30)
- **Pro**: Average quota > 30% (priority +15)
- **Free**: Everything else (no bonus)

Tiers refresh automatically on quota poll. Manual override available via admin API.

---

## License

Internal use only — Nouverse.
