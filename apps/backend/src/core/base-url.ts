/**
 * The gateway's own public URL.
 *
 * Environment only. It used to live in `data/config.json` *as well*, with the
 * env var overwriting the stored value on every load — which meant the
 * dashboard showed an editable field whose edits were silently discarded on the
 * next restart, and two call sites each carried their own copy of the fallback
 * string.
 *
 * This is deployment topology, not a preference: it decides where OAuth
 * redirects land and whether session cookies carry `Secure`. Both are settled
 * before the container starts, by whoever set `BASE_URL`.
 */
export function getBaseUrl(): string {
  const configured = process.env.BASE_URL?.trim();

  if (configured) {
    // Trailing slashes are stripped once here so callers can always append a
    // path without producing a double slash.
    return configured.replace(/\/+$/, '');
  }

  // Falls back to the port the server actually listens on, so a local run with
  // PORT=4000 does not hand out redirect URLs pointing at 3000.
  const port = process.env.PORT?.trim() || '3000';
  return `http://localhost:${port}`;
}
