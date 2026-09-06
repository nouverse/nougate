# Nougate vs 9Router vs OmniRoute

Three projects solve a similar-sounding problem — one endpoint in front of many LLM
providers — and arrive at genuinely different products. This document is for deciding
which one fits a given situation, including the cases where the answer is not Nougate.

> **Scope and honesty note.** Nougate is rated from its source — every claim below was
> checked against the file it describes. 9Router and OmniRoute are described from their
> public repositories and sites as of August 2026; their feature counts are the projects'
> own claims and have **not** been independently verified here. Both move fast, so treat
> version-specific numbers as a snapshot.

**Updated:** September 2026, after cross-provider failover, the Codex and Claude Code providers, and Nougate 1.0.0.

---

## Ratings at a glance

Scale 1–5. The criteria for each dimension are spelled out below, so the numbers can be
checked rather than taken on taste.

| Dimension | Nougate | 9Router | OmniRoute |
|---|:---:|:---:|:---:|
| Architecture & extensibility | **5** | 3 | 4 |
| Provider coverage | 3 | 4 | **5** |
| Client protocol support | 4 | 3 | **5** |
| Routing & resilience | 4 | 4 | **5** |
| Observability & cost attribution | **5** | 2 | 4 |
| Security & access control | 4 | 2 | 4 |
| **Horizontal scalability** | **1** | 1 | **3** |
| Operability | 4 | 4 | 4 |
| Ecosystem & integrations | 2 | 3 | **5** |
| Code quality & verifiability | 4 | 3 | — |
| Openness | **1** | **5** | **5** |

**No average is given on purpose.** Summing dimensions whose weights differ per situation
produces a number that looks objective and means nothing. Use the
[fit table](#which-one-fits) instead.

---

## At a glance

| | **Nougate** | **9Router** | **OmniRoute** |
|---|---|---|---|
| Positioning | Team-operated internal gateway | Local dev proxy, zero-downtime coding | Everything-gateway / AI platform |
| License | Internal (Nouverse) | MIT | MIT |
| Runtime | Bun + TypeScript | Node 20 + Next.js 16 | Node + TypeScript |
| Dashboard | React 19 + Vite, served by the backend | Next.js 16, React 19 | Web UI + Electron + PWA |
| Default port | 3000 | 20128 | 20128 |
| Built-in providers | 4 + unlimited user-defined | 40+ | 291+ catalogued |
| Add-a-provider path | Write a plugin, **or** define one from the dashboard | Fork / contribute upstream | Pick from the catalogue |
| Client protocols | OpenAI + Anthropic, both first-class | OpenAI-compatible (+ translation) | OpenAI, Anthropic, Ollama, Responses |
| Persistence | SQLite **or** Postgres via Drizzle; JSON for accounts | LowDB (single JSON file) | SQLite + optional Redis |
| Multi-account rotation | Health, per-model cooldown, quota-aware, failover | Round-robin / sticky | Circuit breaker, per-key cooldown, model lockout |
| Cross-provider fallback | Yes — bare model fans out, ordered failover | Yes — 3-tier | Yes — 19 strategies, auto-combos |
| Compression | RTK + Headroom + Caveman, **attributed per engine** | RTK + Caveman | 12-engine stack, claims 15–95% |
| Cost analytics | Per request / model / client / **API key**, 90-day rollups | Quota tracking + cost estimate | Cost telemetry, free-tier budget tracker |
| Client authentication | Gateway API keys, **mandatory** | — | Scoped tokens, per-key rate limits |
| Dashboard authentication | Username + password, argon2id, always on | JWT / OAuth / API keys | Password, optional OIDC |
| MCP / A2A / agents | No | No | Yes |
| Multi-instance | **Not supported** | No | Yes (Redis) |

---

## What each rating means

### Architecture & extensibility — Nougate 5 · 9Router 3 · OmniRoute 4

*Can a new provider or feature be added without touching the core?*

Nougate is built on one rule it keeps without exception: **the core never branches on a
provider's name.** Behaviour that differs per provider is expressed as a *capability* — an
optional method on the `IProvider` contract — and callers test for the method. That rule
has been exercised four times now (`getQuotas`, `accountFlow`, `getConfig`, `addAccount`)
and has not once needed an exception. Copilot gained its Quota tab by implementing a single
method: zero changes in the router or the UI.

On top of that, a two-dialect database layer selected by one `DB_URL` variable, with a
parity test that fails the build if the schemas drift.

9Router is monolithic: a new provider means contributing upstream. OmniRoute is clearly
extensible — 291 catalogued providers could not exist otherwise — but the surface is large,
so the cost of understanding before extending is large too.

### Provider coverage — Nougate 3 · 9Router 4 · OmniRoute 5

*How many upstreams work today, without writing code?*

Still a loss, and not worth softening. Four built-in providers — Antigravity, Codex, Claude
Code, Copilot — each wrapping a subscription the operator already pays for, which is the
point rather than an accident of coverage. Custom providers reach any OpenAI- or
Anthropic-compatible endpoint, most of the market, but not upstreams with bespoke auth or a
non-standard wire format. Those need a plugin.

### Client protocol support — Nougate 4 · 9Router 3 · OmniRoute 5

*What can a client speak to the gateway?*

Nougate treats OpenAI and Anthropic as peers rather than translating one into the other.
All four client×upstream combinations live in `core/mappers/`, so an Anthropic-native client
can call an OpenAI-style upstream and vice versa, and the Codex provider adds a third
upstream dialect — OpenAI's Responses API — translated in both directions.

Missing: Gemini native as a *client* protocol, and a native `/codex/v1/responses` route.
`ProtocolId` already carries `'codex'`; only the handler is absent.

### Routing & resilience — Nougate 4 · 9Router 4 · OmniRoute 5

*What happens when something fails?*

**Within a provider**: per-model health scores, per-model cooldowns with a separate
account-wide scope, unified error classification that tells a spent quota apart from a rate
limit, quota-aware ranking, and fail-fast on unknown models.

**Across providers**: a model sent without a `provider:` prefix fans out to every provider
that declares it and holds an account, tried in the operator's own registration order. A
spent quota, dead credentials or an unreachable upstream moves to the next; a malformed body
does not, because every provider would refuse it identically. This closes what was the
headline gap against both alternatives.

Not a 5, and the reasons are specific. Failover is only possible **before the first byte** —
once a stream is flowing to the client there is no taking it back. And the fan-out matches
on an **exact** model id, so `claude-opus-4.6` on Copilot and `claude-opus-4-6-thinking` on
Antigravity are unrelated as far as routing is concerned. Aliasing them needs a curated
table; guessing by normalising punctuation would silently route to a *different model*,
which is worse than an honest error.

### Observability & cost attribution — Nougate 5 · 9Router 2 · OmniRoute 4

*Can you answer "who spent what" months later?*

Nougate records every request to the database, rolls it into daily aggregates for 90 days,
and carries the **API key id** into those rollups — so the chargeback question is answerable
across the full window, not just the detail-log retention. Compression savings are
attributed **per engine**, measured between passes, so "is RTK earning its place" has a
number.

What sets it apart is not the feature count but the discipline: a model with no known rate
is reported *unpriced* and badged, never given a plausible-looking estimate. An unverified
account contributes nothing to a quota average. A row whose figures were partly guessed is
marked `est`. A panel with no data says so instead of rendering an empty chart. A dashboard
that never invents is worth more than one with more graphs.

### Security & access control — Nougate 4 · 9Router 2 · OmniRoute 4

Gateway API keys are **mandatory with no way to switch them off** — an instance with no keys
rejects every proxy request, failing closed. The dashboard uses argon2id with HMAC-signed
session cookies, per-username throttling, and re-reads the user from the database on every
request so deleting an account takes effect immediately.

Loses a point for no IP filtering (deliberate — that is the reverse proxy's job) and no OIDC
for the dashboard.

### Horizontal scalability — Nougate 1 · 9Router 1 · OmniRoute 3

*Can you run more than one instance?*

**Nougate: no — and the Postgres support can mislead here.** The database layer is ready to
be shared; the provider state is not:

- `cooldownMap`, `clientStickyMap` and `cooldownReasons` are module-level `Map`s in both
  providers. Two instances would keep separate cooldowns, so both would hammer an account
  that was just rate limited.
- A per-process `clientStickyMap` means one conversation can bounce between accounts across
  instances, breaking prompt caching and thinking-signature continuity.
- `data/providers/*/accounts.json` is written with **no locking at all**. Two processes
  overwrite each other: health scores, cooldowns and freshly refreshed access tokens can be
  lost.
- Quota polling, the API key cache and the calibrator state are all per-process.

Going horizontal means moving provider state into a shared store — real work, not a config
change. 9Router is equally limited (one LowDB file). OmniRoute scores 3 for documenting
optional Redis for multi-instance; how complete that is was not verified.

For a single-team gateway this ceiling usually does not bind. For something on a critical
path across teams, it does.

### Operability — all three 4

Nougate: one state directory, launch-method-independent paths, atomic and coalesced JSON
writes, idempotent additive column handling at boot, Docker Compose, and CI that typechecks
and tests both halves. Documentation is strong.

### Ecosystem & integrations — Nougate 2 · 9Router 3 · OmniRoute 5

Nougate works with any OpenAI/Anthropic client — and that is all. No MCP server, no agent
protocols, no desktop app. Out of scope by choice, but if you want them, OmniRoute has them
and Nougate will not grow them soon.

### Code quality & verifiability — Nougate 4 · 9Router 3 · OmniRoute —

544 tests, typed contracts, a schema-parity test, and the habit of proving a regression test
catches its bug by sabotaging the fix first.

Loses a point honestly: coverage is thinnest exactly where the code is hottest — ~2,200
lines of Antigravity mappers have almost no behavioural tests, and two test files are
structural (they assert code shape rather than running it). The August 2026 sweep found
**15 bugs in a single pass**; a rate like that means more remain.

OmniRoute is unrated because its code was not reviewed here. Scoring something unexamined
would be inventing a number, which is precisely what this document refuses to do elsewhere.

### Openness — Nougate 1 · 9Router 5 · OmniRoute 5

Nougate is internal to Nouverse: no outside contributors, no third-party security review, and
nobody can fork it if development stops. A real disadvantage against two MIT projects, one of
which claims 500+ contributors.

---

## What moved since the previous revision

| Change | Effect on the rating |
|---|---|
| Cross-provider failover on a bare model id | Routing 3 → 4; the gap the previous revision called the headline one |
| Codex and Claude Code shipped as built-in providers | Coverage 2 → 3 |
| Codex adds the Responses API as a third upstream dialect | Reinforces Client protocol at 4 |
| Gateway API keys became mandatory, failing closed | Security 3 → 4 |
| Per-engine compression attribution, cached-token accounting in the trend chart | Reinforces Observability at 5 |
| Per-model cooldowns, error classifier, calibrator, quota-aware ranking | In-provider resilience |
| 544 tests | Code quality stays at 4 |
| Single-instance limit verified explicitly | Scalability scored honestly at 1 — Postgres support previously implied better |

---

## Which one fits

There is no single winner; the three are not really competing for the same slot.

| Situation | Pick | Why |
|---|---|---|
| One developer who wants coding not to stop when a quota runs out | **9Router** | Fastest path to that outcome; one JSON file is enough state for one person |
| Maximum provider coverage, sophisticated routing, MCP and agent protocols | **OmniRoute** | The only one with all of it, if you can operate that much surface |
| A team sharing a gateway: who spent what, real sign-in, room to move to Postgres, add upstreams from a dashboard | **Nougate** | Built for exactly this |
| A critical path across teams needing more than one instance | **Not Nougate** | Only one instance is safe today; see the scalability section |
| Code others can audit and fork | **9Router / OmniRoute** | Nougate is internal |

The honest summary: **9Router optimises a single developer's uptime, OmniRoute optimises
coverage and capability, Nougate optimises operability and attribution.**

---

## What would move the needle next

Ordered by effect on the table above:

1. **Cross-provider model aliasing** — failover now works, but only on an exact model id.
   `claude-opus-4.6` (Copilot) and `claude-opus-4-6-thinking` (Antigravity) are the same
   model to a person and unrelated to the router, so today exactly one model id is served by
   more than one provider. A curated alias table would multiply that; normalising punctuation
   automatically would not, because a near-miss that silently becomes a different model is
   worse than an error.
2. **Behavioural tests for the mappers** — ~2,200 lines with no net, already proven to hide a
   bug that broke cost reporting on nearly every Anthropic-client request.
3. **Move provider state to a shared store** — the prerequisite for more than one instance.
   Large; do it only when the need is real.

---

## Sources

- [9Router — 9router.com](https://9router.com/)
- [n9router (9Router fork) — github.com/nightwalker89/n9router](https://github.com/nightwalker89/n9router)
- [n9router on npm](https://www.npmjs.com/package/n9router)
- [OmniRoute — github.com/diegosouzapw/OmniRoute](https://github.com/diegosouzapw/OmniRoute)
- [OmniRoute — omniroute.online](https://omniroute.online/)
- Nougate: this repository — `docs/ARCHITECTURE.md` and `apps/backend/src/`
