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
- **Live System Logs**: Console capture with level filtering, search, auto-scroll.
- **Debug Payload Logger**: Dump request/response JSON to disk (configurable, model-filterable, fail-safe).

### Providers

| Provider | Auth | Models |
|----------|------|--------|
| **Antigravity** | Google OAuth (multi-account) | Gemini 3/3.1/3.5 Flash, Gemini 3.1 Pro, Claude Sonnet/Opus 4.6 via Gemini |
| **Copilot** | GitHub Device Flow (multi-account) | Claude Sonnet 4.5, Claude Opus 4.5/4.6, Gemini 2.5 Pro, GPT-4o/4.1/5-mini |

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
  "debugLogger": { "enabled": false, "outputDir": "./tmp/debug-payloads", "modelFilter": [] }
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

# Dashboard authentication (all three required to activate it)
GOOGLE_CLIENT_ID=xxxxxxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=xxxxxxxx
SESSION_SECRET=<openssl rand -base64 32>
```

### Dashboard Authentication (`auth.json`)

Restricts the dashboard to an allowlist of Google accounts. **Scope: the dashboard
and the `/api/*` admin endpoints only.** The LLM proxy routes (`/openai/*`,
`/anthropic/*`) are deliberately left open — CLI clients cannot hold a browser
session, so they need a separate key-based guard.

**`"enabled"` is the only switch.** When it is true the dashboard is closed —
missing Google credentials, an empty allowlist, or a corrupt file all keep it
closed and deny everyone, rather than silently reopening it. The startup banner
says which state you are in.

The file is looked up in this order, first match wins: `/app/data/auth.json`
(Docker), `./data/auth.json`, `./auth.json`. Override with `AUTH_FILE`. Copy
`auth.example.json` to whichever applies — under Docker Compose that is
`./data/auth.json` for dev and `./nougate-data/auth.json` for prod:

```json
{
  "enabled": true,
  "allowedEmails": ["you@example.com"],
  "hostedDomain": null,
  "sessionTtlHours": 168
}
```

| Field | Description |
|-------|-------------|
| `enabled` | The switch. True closes the dashboard; nothing else can reopen it |
| `allowedEmails` | Google accounts permitted to sign in, matched case-insensitively |
| `hostedDomain` | Optional Workspace domain; pre-filters the Google account chooser |
| `sessionTtlHours` | Session cookie lifetime (default 168 = 7 days) |

Setup:

1. Create a **Web application** OAuth client at
   [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials).
2. Register `<BASE_URL>/api/auth/callback` as an authorized redirect URI.
3. Put `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env`.
4. List the allowed emails in `auth.json` and restart.

Notes:

- **No database required.** Sessions are stateless HMAC-signed cookies
  (`HttpOnly`, `SameSite=Lax`, `Secure` when `BASE_URL` is https), so there is
  nothing to store or clean up.
- **No `SESSION_SECRET` needed.** If unset, one is generated on first use and
  stored as `.session-secret` next to `auth.json`, so sessions survive restarts.
- The dashboard shows an **Unprotected** badge in the header whenever the guard
  is off, so an open gateway is visible without reading the logs.
- The allowlist is read live on each dashboard request — adding or removing an
  email takes effect immediately, and a removed email loses access on its very
  next request rather than when its cookie expires.
- `auth.json` is never writable through the admin API, so a compromised dashboard
  cannot grant access to a new account.
- Signing in with an unlisted account returns **403**.
- If the file is missing, disabled, or the env vars are absent, the dashboard
  stays open exactly as before — a half-finished setup will not lock you out.
  Startup logs state which posture is active.

---

## APIs

All models follow `provider:model-id` format.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/openai/v1/models` | GET | List available models (OpenAI format) |
| `/openai/v1/chat/completions` | POST | Chat completions (OpenAI protocol) |
| `/anthropic/v1/models` | GET | List available models (Anthropic format) |
| `/anthropic/v1/messages` | POST | Messages (Anthropic protocol) |

Dashboard authentication endpoints (only active when `auth.json` is configured):

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/auth/me` | GET | Current session, or 401 when signed out |
| `/api/auth/login` | GET | Redirect to the Google consent screen |
| `/api/auth/callback` | GET | OAuth redirect target; issues the session cookie |
| `/api/auth/logout` | POST | Expire the session cookie |

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
