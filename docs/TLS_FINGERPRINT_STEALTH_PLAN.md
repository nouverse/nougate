# TLS Fingerprint Stealth — Future Plan

> Status: **Backlog** — implement when providers start detecting/blocking proxy TLS fingerprints.

## Problem

Every TLS client produces a unique fingerprint during the handshake (cipher suites,
extensions, elliptic curves, etc.). These are catalogued as **JA3** and **JA4** hashes.

Upstream providers (Google, GitHub) can compare the TLS fingerprint of an incoming
request against known client fingerprints:

```
Expected:  JA3 of VS Code / Chrome / official CLI
Actual:    JA3 of Node.js / Bun runtime
Verdict:   Proxy detected → block / rate-limit
```

Currently Nougate spoofs HTTP-level headers (User-Agent, device IDs, etc.) but the
TLS layer is still identifiable as Bun/Node.js.

## When to Implement

- A provider starts rejecting requests that previously worked, with no HTTP-level
  change — suspect TLS fingerprinting.
- Mass 403s or account bans correlated with a provider infrastructure update.
- Providers publicly document or hint at JA3/JA4 enforcement.

**Until then: YAGNI.** Current HTTP-level fingerprinting is sufficient.

## Approach Options

| Option | Pros | Cons |
|--------|------|------|
| **`wreq-js`** (Rust HTTP client, JS bindings) | Full JA3/JA4 control, fast, proven (used by OmniRoute) | Native addon, build complexity |
| **`curl-impersonate`** via subprocess | Battle-tested, exact browser fingerprints | Per-request spawn overhead, not streaming-friendly |
| **Custom `undici` with `tls.connect` options** | Pure JS, no native deps | Limited control over extension order, may not fool advanced detection |
| **Cloudflare Worker / edge proxy** | Fingerprint is Cloudflare's, not yours | Adds latency hop, external dependency |

### Recommended: `wreq-js`

Minimal integration surface — swap the fetch call in the provider's `execute()` with
a wreq-js client configured per-provider fingerprint profile:

```ts
// Pseudocode — provider execute()
const client = wreq.client({
  ja3: FINGERPRINT_PROFILES[this.id], // e.g. "chrome_126" for Antigravity
});
const response = await client.fetch(url, { method, headers, body });
```

Per-provider profiles because each provider expects a different real client:

| Provider | Real Client | Fingerprint to Mimic |
|----------|-------------|---------------------|
| Antigravity | Chrome / Google AI Studio | Chrome latest |
| Copilot | VS Code / GitHub CLI | VS Code Electron |
| Custom | Varies | Configurable per-provider |

## Implementation Scope (when triggered)

1. Add `wreq-js` (or chosen lib) as optional dependency.
2. Fingerprint profile config in `data/providers/<id>/config.json`:
   ```json
   { "tls": { "fingerprint": "chrome_126" } }
   ```
3. Wrap upstream fetch in provider's execute path — only when `tls.fingerprint` is set.
4. Fallback to normal Bun fetch if wreq-js unavailable (graceful degradation).
5. Test: compare JA3 hash of outbound requests with/without stealth.

Estimated effort: ~1-2 days, isolated to provider execution layer.

## References

- Idea observed in [OmniRoute](https://github.com/diegosouzapw/OmniRoute) which uses
  `wreq-js` for TLS fingerprint spoofing (JA3/JA4) per-provider.
- JA3 spec: https://github.com/salesforce/ja3
- JA4 spec: https://github.com/FoxIO-LLC/ja4
- wreq (Rust): https://github.com/aspect-build/wreq
- curl-impersonate: https://github.com/lwthiker/curl-impersonate
