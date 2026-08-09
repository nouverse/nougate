# Nougate vs 9Router vs OmniRoute

Three projects solve a similar-sounding problem — one endpoint in front of many LLM
providers — and arrive at genuinely different products. This document is for deciding
which one fits a given situation, including the cases where the answer is not Nougate.

**Scope and honesty note.** Nougate is described from its source. 9Router and
OmniRoute are described from their public repositories and sites as of August 2026;
their feature counts are the projects' own claims and have not been independently
verified here. Both move fast, so treat version-specific numbers as a snapshot.

---

## At a glance

| | **Nougate** | **9Router** | **OmniRoute** |
|---|---|---|---|
| Positioning | Team-operated internal gateway | Local dev proxy, zero-downtime coding | Everything-gateway / AI platform |
| License | Internal (Nouverse) | MIT | MIT |
| Runtime | Bun + TypeScript | Node 20 + Next.js 16 | Node + TypeScript |
| Dashboard | React 19 + Vite SPA, served by the backend | Next.js 16, React 19 | Web UI + Electron desktop + PWA |
| Default port | 3000 | 20128 | 20128 |
| Built-in providers | 2 (Antigravity, Copilot) + unlimited user-defined | 40+ | 291+ catalogued |
| Add-a-provider path | Write a plugin, **or** define one from the dashboard | Fork / contribute upstream | Pick from the catalogue |
| Client protocols | OpenAI + Anthropic, both first-class | OpenAI-compatible (+ format translation) | OpenAI, Anthropic, Ollama, custom `/v1/responses` |
| Persistence | SQLite **or** Postgres via Drizzle; JSON for provider accounts | LowDB (single JSON file) | SQLite + optional Redis |
| Multi-account rotation | Yes — health-scored, cooldowns, mid-request failover | Yes — round-robin / sticky | Yes — circuit breaker, per-key cooldown, model lockout |
| Cross-provider fallback | **No** | Yes — 3-tier (subscription → cheap → free) | Yes — 19 strategies, auto-combos, live scoring |
| Compression | RTK + Headroom + Caveman | RTK + Caveman | 12-engine stack, claims 15–95% |
| Cost/usage analytics | Per request, per model, per client, **per gateway API key**; rollups to 90 days | Quota tracking + cost estimate | Cost telemetry, free-tier budget tracker |
| Client authentication | Gateway API keys (`sk-nou-…`), mandatory | — | Scoped tokens, per-key rate limits |
| Dashboard authentication | Username + password, argon2id, always on | JWT / OAuth / API keys | Password, optional OIDC |
| MCP / A2A / agents | No | No | Yes — MCP server, A2A, memory, guardrails |
| Deployment | Docker Compose, self-hosted | npm, Docker, PM2/systemd | npm, Docker, Electron, Termux, PWA, remote mode |

---

## What each is actually optimising for

### 9Router — never stop coding

The organising idea is a **3-tier fallback**: when your paid subscription hits a
limit, drop to a cheap API tier, then to a genuinely free one. Everything else — the
40+ providers, the token savers, the quota dashboard — serves that. Install is one
npm command and it wants to run on your laptop.

It is a personal-productivity tool. Storage is a single LowDB JSON file, which is a
sensible fit for one developer and an obvious ceiling for a shared instance.

### OmniRoute — the AI platform

Far broader: 291+ catalogued providers, 19 routing strategies with live 12-factor
scoring, a 12-engine compression stack, a built-in MCP server, A2A, guardrails,
memory/skills systems, and desktop/mobile packaging. It has absorbed most of what an
"AI gateway" could mean.

That breadth is the trade. There is more surface to understand, more to keep working,
and more to audit before it sits on a team's critical path. Provider *coverage* is
its answer to almost everything, where Nougate's answer is provider *depth*.

### Nougate — a gateway a team operates

Two built-in providers, but each is a real integration: Antigravity speaks Google's
Cloud Code Assist protocol with thinking-signature continuity across accounts, and
Copilot reports its actual monthly entitlements. Everything else is expected to
arrive as a **custom provider defined from the dashboard** — an ID, a base URL, an
API style, keys, models — with no code and no restart.

The design centre is operability by more than one person:

- **Attribution over totals.** Usage is grouped by client *and* by gateway API key,
  and the key id is carried into the daily rollups, so "which machine spent this"
  answers across the full 90-day window rather than only the detail-log retention.
- **Two independent auth systems**, because the clients are different. The dashboard
  is username + password (argon2id, HMAC-signed sessions) and is always on. The proxy
  routes take `sk-nou-…` keys, which CLI tools can hold and browsers need not, and are
  required unconditionally — a fresh instance serves nobody until a key exists.
- **A database you can grow into.** Drizzle over two dialect schemas selected by
  `DB_URL`: empty means SQLite, a Postgres URL means Postgres, and no application
  code branches on the choice. A parity test fails the build if the schemas drift.
- **A capability model rather than a provider list.** Adding `getQuotas()` to a
  provider makes its Quota tab appear; nothing in the router or the UI names a
  provider. This is the property most likely to matter as providers are added.
- **Refusal to invent numbers.** A model with no known rate is reported *unpriced* at
  $0 and badged, never given a plausible-looking estimate, because a guessed rate is
  indistinguishable from a real one on a chart.

---

## Where Nougate is behind

Stated plainly, because these are the reasons to pick something else.

**No cross-provider fallback.** This is the biggest functional gap. When a provider
fails, Nougate rotates to another *account within that provider* and then returns an
error; it will not try a different provider. Both alternatives make this their
headline feature. `9ROUTER_ADOPTION.md` sketches a combo layer, unimplemented.

**Two built-in providers, not forty.** Custom providers cover any OpenAI- or
Anthropic-compatible endpoint, which is most of the market — but not upstreams
needing bespoke auth or a non-standard wire format. Those need a plugin.

**No MCP server, no agent protocols, no desktop app.** Out of scope by choice, but if
you want them, OmniRoute has them and Nougate will not grow them soon.

**Browser-redirect OAuth is still Antigravity-specific.** `/oauth/start` and
`/oauth-callback` are hardcoded; a second redirect-OAuth provider requires
generalising them first (see [ARCHITECTURE.md](ARCHITECTURE.md) §10). Device-flow and key-based auth are
already provider-agnostic.

**Fewer compression engines.** RTK, Headroom and Caveman, against OmniRoute's twelve.

**Not open source.** Internal to Nouverse, so no external contributors and no outside
security review — a real disadvantage against two MIT projects, one of which claims
500+ contributors.

---

## Where Nougate is ahead

**Postgres without a rewrite.** Alone among the three in treating the database as a
choice. LowDB's single JSON file will not survive concurrent writers; Nougate's
`DB_URL` switch is config-only and the full test suite runs green on both backends.

**Attribution built for chargeback.** Per-API-key usage that survives into 90-day
rollups is a finance question the others do not appear to answer directly.

**Both protocols as peers.** All four client×upstream combinations are implemented in
shared mappers, so an Anthropic-native client can call an OpenAI-style upstream and
vice versa. The others centre on OpenAI-compatibility with translation around it.

**Custom providers as first-class dashboard objects.** Multi-key rotation with health
scores, auto-discovered models, per-model pricing, per-provider extra headers — the
same machinery the built-in providers use, not a thinner "custom endpoint" path.

**Provider depth.** Thinking-signature caching across account switches, per-model
thinking budgets, per-model timeouts, quota-aware account tiering. This is the payoff
for integrating two providers properly instead of cataloguing hundreds.

**Small enough to audit.** ~17k lines of backend TypeScript with a stated set of
invariants. Whether that reads as a feature depends entirely on whether you have to
operate it.

---

## Choosing

**Pick 9Router** if you are one developer who wants coding to not stop when a quota
runs out. Fastest path to that outcome; a JSON file is enough state for one person.

**Pick OmniRoute** if you want maximum provider coverage, routing sophistication, MCP
and agent protocols in one package, and you are comfortable operating something with
that much surface.

**Pick Nougate** if a team shares the gateway and you need to know who spent what,
sign in with real accounts, put it on Postgres, and add upstreams from a dashboard —
and you can live without cross-provider fallback until it lands.

The honest summary: 9Router optimises for a single developer's uptime, OmniRoute for
coverage and capability, Nougate for operability and attribution. They are not really
competing for the same slot.

---

## Sources

- [9Router — 9router.com](https://9router.com/)
- [n9router (9Router fork) — github.com/nightwalker89/n9router](https://github.com/nightwalker89/n9router)
- [n9router on npm](https://www.npmjs.com/package/n9router)
- [OmniRoute — github.com/diegosouzapw/OmniRoute](https://github.com/diegosouzapw/OmniRoute)
- [OmniRoute — omniroute.online](https://omniroute.online/)
- Nougate: this repository — `docs/ARCHITECTURE.md`, `README.md`, and `apps/backend/src/`
