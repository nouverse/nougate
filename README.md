# Nougate

> Route any LLM provider through any protocol. One gateway, isolated providers, strict model namespacing.

**Nougate** is Nouverse's internal LLM gateway — a modular router that sits between your tools and AI providers. Route requests through OpenAI or Anthropic protocols, authenticate via isolated per-provider accounts, and address any model unambiguously with `provider:model-id` namespacing.

---

## Features

- **Multi-Protocol**: Expose providers via OpenAI (`/openai/v1/`) and Anthropic (`/anthropic/v1/`) compatible APIs simultaneously.
- **Multi-Provider**: Pluggable provider system — each provider owns its auth, accounts, config, and model registry. No shared global state.
- **Strict Model Namespacing**: All models use `provider:model-id` format (e.g. `antigravity:gemini-3.5-flash-low`). No ambiguity, no silent re-routing.
- **Per-Provider Auth Isolation**: Provider credentials, tokens, and account storage are fully isolated. `antigravity` provider uses Google OAuth.
- **Account Rotation & Health Scoring**: Automatically rotates accounts, penalizes on errors, and applies cooldowns on quota exhaustion.
- **Real-time Responsive Dashboard**: Monitor accounts, view live logs, and manage configuration via a built-in React + Tailwind CSS v4 + daisyUI v5 web UI.

---

## Workspace Directory Structure

The repository is structured as a Bun workspaces monorepo:
```
├── apps/
│   ├── backend/          # Bun API backend & routing gateway
│   │   ├── src/          # API & Proxy source files
│   │   └── package.json  # Backend dependencies
│   └── frontend/         # React SPA dashboard UI
│       ├── src/          # React components, hooks, & routing tree
│       ├── dist/         # Production build output (served by backend)
│       └── package.json  # Frontend dependencies
├── config.json           # Global gateway configuration
├── docker-compose.yml    # Docker services orchestration
├── Dockerfile            # Multi-stage production build container
└── package.json          # Root workspace configuration
```

---

## Setup & Running Locally

### Requirements
- [Bun](https://bun.sh) v1.0.0+

### 1. Install Workspace Dependencies
Run the install command from the root workspace directory:
```bash
bun install
```

### 2. Running in Development Mode
To develop locally, run both backend and frontend servers:
```bash
# Start backend server (starts on http://localhost:3000)
bun run dev

# In a separate terminal tab, start frontend dev server (runs on http://localhost:5173 with API proxy)
bun run dev:frontend
```

*Tip: If your backend is running on a different port or host, launch the frontend dev server by passing the `VITE_BACKEND_URL` environment variable:*
```bash
VITE_BACKEND_URL=https://nougate.nouverse.tech bun run dev:frontend
```

### 3. Production Build & Local Serve
To compile the frontend and run the production backend:
```bash
# 1. Compile the React assets into apps/frontend/dist
bun run build:frontend

# 2. Start the production backend server
bun run start
```

---

## Docker Production Deployment

For containerized environments, the gateway runs inside a Docker container managed by Docker Compose. The `Dockerfile` uses a multi-stage compilation pipeline to build the frontend assets and host the final runtime image securely.

To build and launch the container:
```bash
docker compose up -d --build
```

---

## Configuration

### Global Config (`config.json` / `/app/data/config.json`)

The global gateway configuration file controls general behavior and domain redirection rules:

```json
{
  "baseUrl": "http://localhost:3000",
  "rotation": {
    "strategy": "hybrid",
    "cooldown": {
      "defaultDurationMs": 60000,
      "maxDurationMs": 3600000
    }
  },
  "scoring": {
    "healthRange": { "min": 0, "max": 100, "initial": 100 },
    "penalties": {
      "apiError": -10,
      "refreshError": -20,
      "fatalError": -50,
      "systemicError": -5
    },
    "rewards": { "success": 1 },
    "weights": { "health": 2.0, "lru": 0.1 }
  },
  "retry": { "maxAttempts": 5, "transientRetryThresholdSeconds": 5 },
  "tokens": { "expiryBufferMs": 60000 },
  "logging": { "maxBufferSize": 200, "enableConsoleCapture": true }
}
```

*Note: Change the `baseUrl` field to match your reverse proxy domain (e.g. `https://nougate.nouverse.tech`) to ensure Google OAuth redirects are routed back correctly.*

### Environment Variables (`.env`)

You can configure port bindings and override base URL mappings dynamically by placing a `.env` file in the root workspace directory:

```env
PORT=3000
BASE_URL=https://nougate.nouverse.tech
```

*Note: Bun automatically loads environment variables from `.env` files at startup. The `BASE_URL` value provided in `.env` will dynamically override any `"baseUrl"` setting inside `config.json`.*

### Per-Provider Config (`providers/antigravity/config.json` / `/app/data/providers/antigravity/config.json`)

Provider-specific config (endpoints, features, quota):

```json
{
  "endpoints": {
    "sandbox": ["https://us-central1-cloudaicompanion-pa.cloud.google.com"],
    "cli": ["https://cloudaicompanion-pa.googleapis.com"]
  },
  "features": {
    "keepThinking": false,
    "jitterEnabled": true
  },
  "quota": {
    "refreshIntervalMs": 300000
  }
}
```

### Accounts Storage (`providers/antigravity/accounts.json` / `/app/data/providers/antigravity/accounts.json`)

Contains active Google OAuth credentials, current usage statistics, and local cooldown statuses. **Do not commit this file.**

---

## Model Naming & APIs

All models follow the `provider:model-id` format (e.g., `antigravity:gemini-3.5-flash-low`). OpenAI and Anthropic protocol compatibility APIs are exposed at:

- **OpenAI Protocol compatible endpoints**:
  - `GET  /openai/v1/models`
  - `POST /openai/v1/chat/completions`
- **Anthropic Protocol compatible endpoints**:
  - `GET  /anthropic/v1/models`
  - `POST /anthropic/v1/messages`

---

## Integration Guides

### Claude Code CLI

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
      }
    }
  }
}
```
