# Nougate

> Route any LLM provider through any protocol. One gateway, isolated providers, strict model namespacing.

**Nougate** is Nouverse's internal LLM gateway — a modular router that sits between your tools and AI providers. Route requests through OpenAI or Anthropic protocols, authenticate via isolated per-provider accounts, and address any model unambiguously with `provider:model-id` namespacing.

![Nougate Dashboard](screenshots/screenshot.png)

---

## Features

- **Multi-Protocol**: Expose providers via OpenAI (`/openai/v1/`) and Anthropic (`/anthropic/v1/`) compatible APIs simultaneously.
- **Multi-Provider**: Pluggable provider system — each provider owns its auth, accounts, config, and model registry. No shared global state.
- **Strict Model Namespacing**: All models use `provider:model-id` format (e.g. `antigravity:gemini-3.5-flash-low`). No ambiguity, no fallbacks, no silent re-routing.
- **Per-Provider Auth Isolation**: Provider credentials, tokens, and account storage are fully isolated. `antigravity` provider uses Google OAuth; future providers use their own mechanism.
- **Account Rotation & Health Scoring**: Automatically rotates accounts, penalizes on errors, and applies cooldowns on quota exhaustion.
- **Real-time Dashboard**: Monitor accounts, view live logs, and manage config via a built-in web UI.

---

## Model Naming

All models follow the `provider:model-id` format:

```
antigravity:gemini-3.5-flash-low
antigravity:claude-sonnet-4-6
antigravity:gpt-oss-120b
```

**Provider and protocol are independent.** You can use an `antigravity` model through the OpenAI protocol or the Anthropic protocol — it's your choice.

> [!IMPORTANT]
> Requests with a model string that does not include a provider prefix will be rejected with `400 Bad Request`.

---

## API Routes

```
# OpenAI Protocol
GET  /openai/v1/models
POST /openai/v1/chat/completions

# Anthropic Protocol
GET  /anthropic/v1/models
POST /anthropic/v1/messages

# Admin
GET  /api/status
GET  /api/sse
GET  /api/config
POST /api/config
GET  /oauth/start
```

> [!WARNING]
> Legacy routes (`/v1/chat/completions`, `/v1/messages`, `/v1/models`) are **not supported**. Update your client config accordingly.

---

## Providers

### `antigravity`

Routes to Google's internal Cloud Code endpoints via OAuth. Supports Gemini, Claude (via Google), and GPT-OSS models.

**Available models:**

| Model ID | Pool | Thinking |
|---|---|---|
| `antigravity:gemini-3.5-flash-low` | sandbox | ✅ level/low |
| `antigravity:gemini-3.5-flash-high` | sandbox | ✅ level/high |
| `antigravity:gemini-3.1-pro` | sandbox | ✅ level/low |
| `antigravity:gemini-3.1-pro-high` | sandbox | ✅ level/high |
| `antigravity:gemini-3-pro` | sandbox | ✅ level/low |
| `antigravity:gemini-3-flash` | cli | ❌ |
| `antigravity:gemini-2.5-pro` | sandbox | ❌ |
| `antigravity:gemini-2.5-flash` | sandbox | ❌ |
| `antigravity:gemini-2.5-flash-thinking` | sandbox | ✅ budget |
| `antigravity:claude-sonnet-4-6` | sandbox | ❌ |
| `antigravity:claude-sonnet-4-6-thinking` | sandbox | ✅ budget |
| `antigravity:claude-opus-4-6` | sandbox | ❌ |
| `antigravity:claude-opus-4-6-thinking` | sandbox | ✅ budget |
| `antigravity:gpt-oss-120b` | cli | ❌ |
| `antigravity:gpt-oss-120b-medium` | cli | ❌ |

---

## Integration Guides

### Claude Code

```bash
export ANTHROPIC_BASE_URL="http://localhost:3000/anthropic"
claude --model antigravity:claude-sonnet-4-6
```

### OpenCode

```json
"provider": {
  "nougate": {
    "npm": "@ai-sdk/openai-compatible",
    "name": "Nougate",
    "options": {
      "baseURL": "http://localhost:3000/openai/v1"
    },
    "models": {
      "antigravity:gemini-3.5-flash-low": {
        "name": "Gemini 3.5 Flash Low",
        "limit": { "context": 1048576, "output": 65535 }
      },
      "antigravity:claude-sonnet-4-6-thinking": {
        "name": "Claude Sonnet 4.6 (Thinking)",
        "limit": { "context": 1000000, "output": 64000 }
      },
      "antigravity:gemini-3.1-pro-high": {
        "name": "Gemini 3.1 Pro High",
        "limit": { "context": 1048576, "output": 65535 }
      }
    }
  }
}
```

### OpenAI-compatible clients (curl)

```bash
curl http://localhost:3000/openai/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-nougate" \
  -d '{
    "model": "antigravity:gemini-3.5-flash-low",
    "messages": [{ "role": "user", "content": "Hello!" }],
    "stream": true
  }'
```

---

## Running Locally

Requirements: [Bun](https://bun.sh) v1.0.0+

```bash
bun install
bun run dev       # development with watch mode
bun run start     # production
```

Server starts on port `3000` by default.

---

## Configuration

### Global (`config.json`)

Proxy-level behavior shared across all providers:

```jsonc
{
  "rotation": { "strategy": "sticky" },
  "scoring": { ... },
  "retry": { "maxAttempts": 5 },
  "logging": { "maxBufferSize": 200 }
}
```

### Per-Provider (`providers/antigravity/config.json`)

Provider-specific config (endpoints, features, quota):

```jsonc
{
  "endpoints": { "sandbox": [...], "cli": [...] },
  "features": { "keepThinking": false, "jitterEnabled": true },
  "quota": { "refreshIntervalMs": 300000 }
}
```

### Accounts (`providers/antigravity/accounts.json`)

Runtime state — OAuth tokens, health scores, cooldowns. **Do not commit this file.**

---

## Account Selection Strategies

| Strategy | Behavior |
|---|---|
| `sticky` | Pins a client session to the same account |
| `hybrid` | Scores by `(health × 2) + (idle time × 0.1)` |
| `round-robin` | Cycles through accounts evenly |

---

## Security

- OAuth tokens are stored in `providers/antigravity/accounts.json` — **never commit this file**.
- Each provider's credentials are fully isolated from other providers.
- All safety filters default to `BLOCK_NONE` (configurable).
