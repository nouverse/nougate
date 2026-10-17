# Working on this repo

---

## Running

```bash
bun install

bun run dev            # backend, watch mode, http://localhost:3000
bun run dev:frontend   # vite dev server on :5173, proxies the API
bun run build:frontend && bun run start   # production shape

./run-dev.sh           # the full dev container (compose)
docker compose -f docker-compose.dev.yml up -d
```

The dev container mounts `apps/*/src`, rebuilds the frontend on change via
`inotifywait`, and runs the backend under `bun --watch`.

**`node_modules` are named volumes, not bind mounts.** Bun's workspace install
symlinks `apps/backend/node_modules/*` into the repo-root store, so the container
needs real directories at `/app/node_modules`, `/app/apps/*/node_modules` and runs
its own `bun install`. Bind-mounting the host's `node_modules` produces
`ENOENT … /app/apps/backend/node_modules/drizzle-orm`.

### Docker env

`.env` is read by Compose for `${VAR}` **substitution in the compose file**. It does
*not* reach the container unless listed under `environment:` or pulled in with
`env_file:`. Every compose file declares both:

```yaml
env_file:
  - path: .env
    required: false
environment:
  - HEADROOM_URL=${HEADROOM_URL:-}   # explicit entries win over env_file
  - BASE_URL=${BASE_URL:-http://localhost:3000}
```

`BASE_URL` comes from `.env` in every one of them, `docker-compose.prod.yml` included,
whose fallback is `https://nougate.nouverse.tech` (it was pinned there until `a1d202c`).
So on the production host `.env` names the public address or leaves `BASE_URL` out:
a developer's localhost value carried there drops the Secure flag from session cookies
and breaks OAuth redirects.

Never run `docker compose config` to inspect this — it prints every secret in the
environment to the terminal.

---

## Testing

```bash
cd apps/backend
bun test tests/unit                          # the suite that gates a change
bun test tests/unit/<file>.test.ts
bun test tests/unit -t "name of the test"
bunx tsc --noEmit                            # also `bun run lint:check`
```

Conventions:

- **Prove the test catches the bug.** Break the fix, watch it fail, restore it. A
  regression test that passes against the broken code is worse than none.
- **Isolate state.** Point `CONFIG_FILE` / `NOUGATE_DB_PATH` / `*_ACCOUNTS_FILE` at a
  temp path. A smoke test once wrote `apiKeys.enabled: true` into the repo's real
  `config.json`.
- **`expect(promise).rejects.toThrow()`**, never `expect(await fn()).rejects` — the
  inner `await` rejects before `expect` sees it.
- **Await async flushes.** They are effectively synchronous on SQLite and genuinely
  async on Postgres; a missing `await` passes locally and fails on the other backend.
- Fixtures for an undocumented upstream come from a **captured real response**. Probe
  with a throwaway script in `apps/backend/tests/tmp/`, redact secrets from anything
  you print, delete the directory afterwards.

---

## Confirming your change is actually running

The dev container builds the frontend **inside** the container, so the bundle hash on
disk will not match the served one. That difference is normal; a stale *behaviour* is
not. Check the log, not the hash:

```bash
docker logs nougate-dev --since 60s | grep -iE "rebuilt|error|built in|running on port"
```

A `tsc` error there means the container is still serving the previous build — your
code is not running, however clean your local build was.

---

## Git hygiene

- `apps/frontend/tsconfig.tsbuildinfo` is tracked and rewritten by every typecheck.
  `git checkout` it before reporting; it is pure noise in a diff.
- Commit only when asked.
- Root-level `*_PLAN.md` / `*_ADOPTION.md` files are historical planning notes, some
  already implemented. Do not treat them as specifications for current behaviour —
  read the code.

---

## Things that have actually gone wrong here

Each of these shipped, or nearly did:

| Symptom | Cause |
|---|---|
| Data vanished between `bun run dev` and Docker | paths resolved from `process.cwd()` → two databases |
| Custom-provider data lost on container recreate | fresh volume, state written into the image layer |
| Bun's HTML debug page returned to an API client | unhandled throw in `execute()`; it leaks filesystem paths |
| Custom providers missing from client model pickers | `/openai/v1/models` only iterated the default provider |
| `/frontend/users` 404 after a deploy | `index.html` cached; no `no-store`, no `notFoundComponent` |
| Sidebar kept an old provider name | `displayName` copied in the constructor instead of a getter |
| Quota bar empty on an unlimited plan | `remaining / entitlement` = `0/0` = `NaN` |
| Gateway keys rejected after any key edit | cache invalidated to `null`, but verification is synchronous |
| A test asserted coverage it did not have | claimed in a comment; no such test existed |
| A live `data/nougate.db` was deleted during cleanup | "test residue" that was not |
| A real `GOOGLE_CLIENT_SECRET` printed to the terminal | `docker compose config` |

The pattern behind most of them: a value snapshotted where it should have been read
through, or a fallback that hid a failure instead of surfacing it.
