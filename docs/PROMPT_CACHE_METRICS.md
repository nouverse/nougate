# Prompt cache accounting

**Status:** shipped, not yet observed on a live deployment.

A handover note for the next person: what was added, why the numbers looked wrong before it, and the
two things worth checking once real traffic has run through.

---

## The problem

Nougate already read the upstream's cache counters. `core/usage-cache.ts` extracts them from three
shapes — `usageMetadata.cachedContentTokenCount` (Gemini / Cloud Code),
`usage.prompt_tokens_details.cached_tokens` (OpenAI), `usage.cache_read_input_tokens` (Anthropic) —
and `metrics/tracker.ts` has priced cache reads at 10% of list since they were added:

```ts
const billableInput = Math.max(0, inputTokens - totals.cachedInputTokens);
const inputCost =
  costOf(billableInput, pricing.inputPricePer1M) +
  costOf(totals.cachedInputTokens, pricing.inputPricePer1M * 0.1);
```

So **the bill was already correct**. What was missing is that nothing recorded the *saving*.
`costSaved` meant compression and only compression, so the dashboard's savings figure ignored the
cache completely. Measured on a live Nouride install talking through Nougate: a second turn in one
conversation read **16,174 of its 20,995 input tokens from cache — 77%** — and the dashboard reported
no benefit for it, because the only thing that had changed was a smaller number in a different column.

That is the worst shape a metric can take. It is not absent, so nobody goes looking; it is just
quietly incomplete.

---

## What was added

Two engines, two numbers, one total. Deliberately *not* folded into `costSaved`: the compression
breakdown panel exists to answer "which engine saved what", and one blurred total would answer
"are we saving" while losing "how".

| layer | field | notes |
| --- | --- | --- |
| `metrics/tracker.ts` | `cacheCostSaved` | `cachedInputTokens × inputPricePer1M × 0.9`. The **discount**, not the price: a cache read still costs 10% of list, so 90% is what was not spent. |
| `metrics/logger.ts` | `cacheCostSaved` | on `TokenLogEntry`, written with every row |
| `db/schema/{sqlite,pg}.ts` | `cache_cost_saved` on `token_usage_logs` | plus `total_cached_input_tokens` and `total_cache_cost_saved` on `token_usage_daily_rollups` |
| `db/ddl/{sqlite,pg}.ts` | the same columns | for databases created from now on |
| `db/index.ts` → `ADDED_COLUMNS` | three entries | for databases already in use — see below |
| `metrics/maintenance.ts` | rollup aggregation | `coalesce(sum(...), 0)`, because rows written before the column existed are NULL and `SUM` over NULLs is NULL |
| `metrics/queries.ts` | `UsageSummary.cachedInputTokens`, `.cacheCostSaved` | both the rollup and the raw-log branch; `originalCost` and `savingsPercent` now include the cache saving |
| `frontend/routes/tokens.tsx` | **Saved by prompt cache** tile | value is the money, badge is the hit share, hint is `cached of input` |

### The existing-database part is the one that matters

Nougate has no migration history — `CREATE TABLE IF NOT EXISTS` runs every boot, which is a no-op once
the table exists. `ADDED_COLUMNS` in `core/db/index.ts` is the additive escape hatch, and the three new
columns are registered there:

```ts
{ table: 'token_usage_logs',              column: 'cache_cost_saved',           type: 'REAL' },
{ table: 'token_usage_daily_rollups',     column: 'total_cached_input_tokens',  type: 'INTEGER' },
{ table: 'token_usage_daily_rollups',     column: 'total_cache_cost_saved',     type: 'REAL' },
```

Postgres gets `ADD COLUMN IF NOT EXISTS`; SQLite is asked with `PRAGMA table_info` first. Rows written
before the deploy keep NULL there, which is why every aggregation coalesces. **Nothing is rewritten and
no history is dropped.**

---

## What to check once traffic has run

1. **The hit share is not zero.** `Saved by prompt cache` on the Token Usage page shows a percentage
   badge. Zero means the upstream is not returning cache counters, not that caching is off — check
   `core/usage-cache.ts` against what the provider actually sends before touching anything else.
2. **The rollup carries it.** The 7d and 30d windows read from `token_usage_daily_rollups`, the 24h
   window from the raw logs. If the short window shows a saving and the long one does not, the rollup
   job (`metrics/maintenance.ts`) has not run since the columns were added — it folds yesterday and
   earlier, so give it a day, or trigger maintenance by hand.

Both are the same class of failure and the reason this note exists: a metric that reads 0 is
indistinguishable from a metric that is broken, and only one of them is worth investigating.

---

## Related

- `core/usage-cache.ts` — where the three upstream shapes are normalised, and the four emit sites that
  have to agree.
- `docs/token-compression/README.md` — the other savings engine, and the breakdown panel this sits
  beside.
- On the Nouride side: `apps/engine/src/db/migrations/016_usage_cached_tokens.sql` records the same
  counters per turn, so the two systems can be reconciled against each other.
