# 9Router Feature Adoption — Quick Wins for Nougate

> Features worth adopting from 9Router, prioritized by impact and implementation effort.

---

## 1. Cross-Provider Fallback (Combos)

**What:** If Antigravity fails (quota/error), auto-fallback to Copilot (or vice versa). User defines a priority chain.

**Why:** Single biggest UX gap vs 9Router. Currently if one provider dies, client gets an error. With fallback, zero downtime.

**Effort:** Medium — executor already returns error status. Add a combo layer above provider dispatch that catches failures and retries with next provider in chain.

**Sketch:**
```
// combo config
{ name: "always-on", chain: ["antigravity:gemini-3-flash-agent", "copilot:claude-opus-4.6"] }

// routing: try chain[0], on failure try chain[1], ...
```

---

## 2. Built-in RTK (Tool Result Compression)

**What:** Auto-compress `tool_result` content (git diff, grep, ls, tree, file reads) before sending to LLM. Lossless, filter-based.

**Why:** Headroom is an external service that can timeout (we just fixed this). RTK runs inline — zero network overhead, zero timeout risk. Can coexist with Headroom as a first-pass filter.

**Effort:** Low-Medium — implement filters for common tool output patterns (git-diff, grep, ls, tree, dedup-log). Apply before Headroom compression in the pipeline.

**Filters to port:**
- `git-diff` — strip unchanged context lines, collapse hunks
- `grep` / `find` / `ls` — deduplicate paths, collapse directory trees
- `dedup-log` — collapse repeated log lines
- `smart-truncate` — cap oversized tool results

---

## 3. Caveman Mode (Terse Output Injection)

**What:** Inject a system prompt that makes LLM reply compact. 5 intensity levels. Claims -65% output tokens.

**Why:** Dead simple to implement. One system prompt injection. Huge token savings on output side (RTK/Headroom only save input).

**Effort:** Very Low — add optional system prompt prepend in the mapper layer. Toggle via config/admin API.

---

## 4. Multi-Account Round-Robin per Provider (Enhanced)

**What:** 9Router does round-robin + priority-based routing across multiple accounts per provider.

**Why:** Nougate already does pool rotation with health scores, but could adopt:
- **Sticky sessions** — same conversation sticks to same account (avoids signature cache misses across accounts)
- **Priority weights** — prefer certain accounts over others

**Effort:** Low — extend existing `getBestAccount` logic.

---

## Not Worth Adopting

| Feature | Why Skip |
|---|---|
| MITM Bridge | Ethically gray, legally risky, not aligned with Nougate's purpose |
| Next.js Dashboard | Nougate's Bun server is leaner. If UI needed, build a separate SPA |
| Ponytail | Gimmick — overlaps with Caveman and adds prompt bloat |
| Cloud Sync | Overkill for current scope |
| 9 Service Types (TTS/STT/Image/Video) | Out of scope — Nougate is a coding proxy, not a multi-modal gateway |
