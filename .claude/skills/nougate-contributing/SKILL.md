---
name: nougate-contributing
description: How to work on the Nougate gateway codebase — provider contracts, the dual-dialect database layer, state paths, dashboard auth, frontend conventions, and the mistakes that have actually been made here. Use when adding or changing a provider, touching the DB schema or metrics, editing state files, or building dashboard UI in this repo.
---

# Contributing to Nougate

Nougate is a multi-provider LLM gateway: clients speak OpenAI or Anthropic protocol,
providers are isolated plugins, and every model is addressed as `provider:model`.

This skill exists because the same handful of mistakes keep recurring. Read the
invariants below before writing code. They are not style preferences — each one
corresponds to a bug that shipped.

---

## The seven invariants

**1. Never branch on a provider id.** Not in the router, not in the UI, not in a
config lookup. If behaviour differs per provider, that difference is a *capability*
declared on the contract — an optional method on `IProvider` — and the caller tests
for the method, not the name.

```ts
// Right: the contract decides.
const supportsQuota = typeof provider.getQuotas === "function";

// Wrong: a new provider now needs core edits to gain the feature.
const supportsQuota = provider.id === "antigravity";
```

**2. No legacy paths, no fallback chains.** Breaking changes are acceptable in this
repo; silent compatibility shims are not. One canonical location per file, one code
path per behaviour. If you find yourself writing "try A, else B", stop and pick one.

**3. All state lives under `data/`, resolved through `core/paths.ts`.** Never
`process.cwd()`, never a path relative to a source file. `bun run dev` runs from
`apps/backend`, Docker runs from `/app`, and both must read the same bytes.

**4. The two DB schemas must stay in step.** `core/db/schema/sqlite.ts` and
`schema/pg.ts` are the same tables written twice. `tests/unit/schema-parity.test.ts`
fails the build if they diverge. Every query is written with `await`.

**5. Never invent a number.** An unpriced model is reported as unpriced, not given a
plausible rate. An unverified account contributes nothing to a quota average, not a
zero. A guessed value is indistinguishable from a real one on a chart.

**6. Prove a test catches the bug.** After writing a regression test, break the fix
and confirm the test fails. A test that passes against the broken code is worse than
no test, because it reads as coverage.

**7. Secrets never reach stdout.** No token, password, session secret or API key in
a log line, a debug dump, or a terminal command you run while investigating.
`docker compose config` prints the whole environment — do not.

---

## Repo map

```
apps/backend/src/
  core/
    interfaces.ts     # IProvider, IAccount, IModelSpec, IProviderQuota, IProtocolHandler
    registry.ts       # provider + protocol-handler registration
    model-resolver.ts # "provider:model" parsing
    paths.ts          # THE path resolver — every state file goes through it
    state-file.ts     # atomic + debounced JSON writes
    events.ts         # adminEventBus → dashboard SSE
    db/               # Drizzle: index.ts (dialect switch), schema/, ddl/
    metrics/          # logger, queries, pricing, price-book, maintenance, tracker
    mappers/          # protocol translation shared by all providers
  protocols/          # openai/, anthropic/ — client-facing wire formats
  providers/          # antigravity/, copilot/, custom/ — isolated plugins
  auth/               # dashboard users, sessions, gateway API keys, guard
  router/             # admin, metrics, api-keys, custom-providers, users, auth
  server.ts           # bootstrap + registration order

apps/frontend/src/    # React 19 + Vite + TanStack Router (basepath /frontend)
data/                 # ALL runtime state (see references/data-and-state.md)
```

---

## Task guides

Load the file that matches what you are doing:

| Doing this | Read |
|---|---|
| Adding a provider, wiring OAuth or device flow | `references/adding-a-provider.md` |
| Touching the DB, schema, metrics or pricing | `references/data-and-state.md` |
| Dashboard UI, routes, tables, panels | `references/frontend.md` |
| Running, testing, debugging the dev container | `references/workflow.md` |

---

## Before you say you are done

- `cd apps/backend && bunx tsc --noEmit` — clean.
- `cd apps/backend && bun test tests/unit` — all green.
- `cd apps/frontend && ./node_modules/.bin/tsc -b && npx vite build` — clean.
- If the dev container is up, confirm it rebuilt: `docker logs nougate-dev --since 60s`.
  A failed rebuild there means the running app is *not* your code.
- `git checkout apps/frontend/tsconfig.tsbuildinfo` — it is tracked and churns on
  every typecheck; do not leave it in the diff.

Report what you actually verified. "Tests pass" means you ran them.
