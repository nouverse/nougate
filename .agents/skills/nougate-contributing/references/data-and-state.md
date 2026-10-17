# Data, state and metrics

---

## Where state lives

One directory, one path per file. `/app/data` in Docker, `<repo>/data` locally.

```
data/
├── config.json                       # global gateway config
├── nougate.db                        # users, metrics, API keys, custom providers
├── signatures.json                   # thinking-signature cache (disposable)
├── .session-secret                   # cookie signing key, generated on first run
└── providers/
    ├── antigravity/{accounts,config}.json
    └── copilot/{accounts,config}.json
```

**Always resolve through `core/paths.ts`.** `dataPath('providers', 'copilot', 'accounts.json')`,
never a string built from `process.cwd()` or `import.meta.dir`.

`getProjectRoot()` walks up from `import.meta.dir` to the `package.json` that declares
`workspaces`, so it is identical whether the process starts in `apps/backend` (`bun run
dev`), the repo root (`bun run start`), or `/app` (Docker). A `cwd`-relative path
produced **two separate databases** and silently lost data between launch methods.

Env overrides exist for individual files (`NOUGATE_DB_PATH`, `CONFIG_FILE`,
`ACCOUNTS_FILE`, `COPILOT_ACCOUNTS_FILE`, `ANTIGRAVITY_CONFIG_FILE`,
`COPILOT_CONFIG_FILE`, `SESSION_SECRET_FILE`). Tests use them to isolate; production
should not need them.

`config.example.json` is documentation. Nothing reads it at runtime.

---

## JSON state files

Provider accounts and configs stay JSON so they can be inspected and hand-edited.
They hold OAuth refresh tokens, so a torn write is data loss.

Use `core/state-file.ts`:

```ts
const writer = createStateFileWriter<Shape>(path, { label: 'copilot accounts' });
writer.schedule(data);                 // coalesced, ~1s debounce
writer.flush();                        // force now — use when credentials changed
```

- `writeJsonAtomic()` writes a temp file and `renameSync`s it, cleaning up `.tmp` on
  failure. A crash mid-write leaves the previous file intact.
- Debouncing matters: an unthrottled per-request save wrote ~6 MB for 500 rotations;
  coalescing brought the same run to a single 12 KB write.
- `flushAllStateFiles()` is registered on `exit` only. The signals are the process owner's: a gateway on its own
  answers SIGINT and SIGTERM in `standalone.ts`, and a host (Nouride) calls `shutdown()` from `boot.ts`. A handler
  installed here once ran before Nouride's and exited the daemon under its own shutdown.
- Pass `{ immediate: true }` when a credential changed. Scoring updates can wait.

---

## The database layer

Drizzle ORM over two dialects, selected by `DB_URL`:

| `DB_URL` | Backend |
|---|---|
| *(empty)* | SQLite at `data/nougate.db` — the default |
| `sqlite:/path.db`, `file:///path.db` | SQLite there |
| `postgres://…`, `postgresql://…` | Postgres |
| anything else | throws — it will not silently fall back |

`core/db/index.ts` picks the schema and exports it as `t`, plus a `timeBucket`
helper. `initDb()` runs `IF NOT EXISTS` DDL from `ddl/sqlite.ts` or `ddl/pg.ts`.

### Four rules

**1. Change one schema, change the other.** `schema/sqlite.ts` and `schema/pg.ts` are
the same tables written twice, because Drizzle types tables per dialect.
`tests/unit/schema-parity.test.ts` compares table names, column names, nullability,
defaults and JS `dataType`, and fails the build on drift. It has been verified by
sabotage — it does catch it.

**2. Postgres mirrors SQLite's JS types deliberately.** Epoch milliseconds are
`bigint({ mode: 'number' })`, not `timestamp`. Costs are `doublePrecision`, matching
`real`. Booleans are `0/1 integer`, not `boolean`. The point is that a row round-trips
to the same JavaScript values on both backends, so no call site knows which it is on.

**3. Await everything.** The Bun SQLite driver is synchronous, `postgres-js` is not.
Drizzle's SQLite query builders are thenable, so `await` works on both — which is the
whole reason one set of queries can serve two dialects. A missing `await` passes on
SQLite and fails on Postgres.

**4. Raw SQL lives only in `ddl/`.** One exception: `timeBucket()`, the single
fragment the dialects genuinely disagree on.

```ts
// sqlite
sql`strftime(${format}, ${column} / 1000, 'unixepoch')`
// pg — format is sql.raw, NOT a bound parameter: Postgres cannot infer a type
// for a parameter in to_char's format position.
sql`to_char(to_timestamp(${column} / 1000.0) at time zone 'UTC', ${format})`
```

### Adding a table

1. Add it to both schema files with matching column names and types.
2. Add its `CREATE TABLE IF NOT EXISTS` to both `ddl/` files.
3. Export it from both `schema` objects.
4. Run `bun test tests/unit/schema-parity.test.ts`.

### Adding a column to a table that already exists

`CREATE TABLE IF NOT EXISTS` is a no-op once the table exists, so a new column never
reaches a live database from the DDL alone — the first query fails with
`no such column`.

Add it to `ADDED_COLUMNS` in `core/db/index.ts` as well as both schemas and both DDL
files. `initDb()` then adds it idempotently (`ADD COLUMN IF NOT EXISTS` on Postgres, a
`PRAGMA table_info` check on SQLite).

That list is **strictly additive and nullable**, and must not become a migration
framework. Anything that rewrites, renames or drops data needs a real migration story;
until then such a change requires deleting `data/nougate.db` and must be called out in
the README.

---

## Metrics

`core/metrics/`:

| File | Role |
|---|---|
| `tracker.ts` | records one request; called from both protocol handlers |
| `logger.ts` | buffers rows, batch-inserts every 5s |
| `queries.ts` | every dashboard read; `scopeLogs`/`scopeRollups` build the filters |
| `maintenance.ts` | hourly rollup into daily aggregates + pruning |
| `pricing.ts` | resolves a rate for a model |
| `price-book.ts` | built-in rates matched on model family |
| `compression.ts`, `tokenizer.ts` | savings accounting, token estimation |

**Recording must never block a response.** Rows go into an in-memory buffer and are
flushed on a timer. A slow or locked database cannot stall an in-flight LLM stream.

**`provider` is always `provider.id`.** Both handlers record it that way, and the
dashboard's provider filter compares against it.

**Retention is one number, used twice.** `core/metrics/retention.ts` owns it: the pruner
deletes with it and the read side picks detail-vs-rollup with it. Do not reintroduce a
threshold constant beside it — when the two drifted, raising retention kept rows that
nothing would ever read.

**Attribution** is by client *and* by gateway API key, and the two compose. The API
key id is carried into the daily rollups too, so the filter works across the full
90-day window rather than only the 14-day detail retention.

### Compression attribution

`prepareRequestPayload` measures the payload between each pass, so every engine's
saving is recorded on its own. Rules:

- **The parts must sum to the total.** `tokensSaved` is the sum of `byEngine`, never a
  separately-computed figure — a remainder shows up in the dashboard as savings that
  nothing accounts for.
- **Enabled-but-saved-nothing is reported at 0; disabled is absent.** Collapsing the two
  hides a filter that has stopped matching anything.
- **The breakdown is a JSON column on the detail log only.** The engine set is not
  fixed, so widening the rollup key per engine would multiply its rows. Longer windows
  return `available: false` rather than a partial breakdown that reads as "saved
  nothing".

Adding an engine means measuring it in `compression.ts` and giving it a label in the
dashboard's `ENGINE_LABELS`; no schema change.

### Pricing: never invent a rate

`resolvePricing()` order:

1. the model spec's own `inputPricePer1M`/`outputPricePer1M`
2. the built-in price book, matched on model family (handles aggregator ids like
   `anthropic/claude-opus-4.5`)
3. an optional blanket rate from `metrics.defaultInputPricePer1M` /
   `defaultOutputPricePer1M` — **0 by default, i.e. off**
4. otherwise: `isPriced: false`, cost `$0`, badged **unpriced** in the dashboard

An explicit `0` is a real price, not "unknown" — the distinction is tested. A guessed
rate is indistinguishable from a real one on a chart, so nothing is invented silently.

---

## Dashboard auth

- Users live in SQLite. First run seeds `admin` / `admin123` with
  `mustChangePassword`, which unlocks exactly one screen; everything else returns
  `403 password_change_required`.
- Passwords: argon2id via `Bun.password`. Verification is timing-equalised with a
  dummy hash so an unknown username costs the same as a wrong password.
- Sessions: stateless HMAC-signed cookies, `HttpOnly`, `SameSite=Lax`, `Secure` when
  `BASE_URL` is https. The user is re-read from the DB on every request, so deleting
  an account takes effect immediately.
- Throttling is per username: five failures, 60-second lockout, isolated per account.
- `getActiveUser` and `enforceDashboardAuth` are **async**.
- Gateway API keys are separate and guard `/openai/v1/*` and `/anthropic/v1/*`.
  They are **always required** — there is no `apiKeys.enabled` config any more, and an
  instance with zero keys rejects every proxy request. Do not reintroduce a switch, and
  do not special-case the empty-key-list state into an open one.
  `verifyApiKey` is **synchronous**, reading an in-memory cache. After any mutation
  call `refreshCache()` — setting the cache to `null` breaks synchronous verification,
  which was a real bug.
