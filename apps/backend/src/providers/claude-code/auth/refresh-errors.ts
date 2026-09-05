/**
 * Telling "this refresh token is finished" apart from "the network was having a moment".
 *
 * The distinction is the entire point of this file, and getting it wrong is expensive in one
 * direction only. A refresh that fails because DNS blinked is a retry; a refresh that fails because
 * the grant was revoked is a sign-in the operator has to perform by hand. Treating the first as the
 * second retires a working subscription over a dropped packet — and because `invalidate()` is
 * deliberately permanent, nothing brings it back but a person noticing.
 *
 * So the rule here is: **invalidate only on a reason the server actually stated.** Anything else —
 * a 500, a timeout, an HTML error page from a captive portal — leaves the account alone.
 *
 * ## Why the matching is on a combined string rather than a status code
 *
 * OAuth2 puts the machine-readable reason in the *body*, not the status: `invalid_grant` arrives as
 * a 400, and so does a malformed request that says nothing about the grant. Anthropic additionally
 * uses `refresh_token_reused` and `refresh_token_expired`, which are not in the RFC at all. Keying on
 * 400 would invalidate on both; keying on the body's `error` code distinguishes them.
 *
 * `refresh_token_reused` deserves its own note: it means two refreshes raced on one token, and the
 * server invalidated the family. That is what `single-flight.ts` exists to prevent — this classifier
 * is what makes it visible when prevention fails, rather than surfacing as a mysterious dead account.
 */

/** Reasons the server gave that mean the grant itself is gone, not that the call went wrong. */
const PERMANENT_MARKERS = [
  'invalid_grant',
  'refresh_token_expired',
  'refresh_token_reused',
  'refresh_token_invalidated',
  'invalid_request',
] as const;

export interface RefreshFailure {
  /** HTTP status, or 0 when the request never produced one (network error, abort). */
  status: number;
  /** The server's machine-readable code, when it gave one. Empty string when it did not. */
  code: string;
  /** Human-readable detail, already truncated — this reaches a log line and the dashboard. */
  description: string;
  /**
   * Whether re-authorizing is the only fix.
   *
   * False is the safe default and the one every unrecognized failure gets: an account left healthy
   * after a permanent failure costs one more 401 next request, while an account invalidated after a
   * transient one costs the operator a manual sign-in.
   */
  permanent: boolean;
}

/** How much of an error body is worth keeping. Enough to diagnose, short enough for one log line. */
const MAX_DESCRIPTION = 300;

/**
 * Read whatever the token endpoint returned into a decision.
 *
 * Tolerant of the body being anything at all — an OAuth JSON error, a proxy's HTML, or nothing —
 * because a classifier that throws on a surprising body turns an ordinary upstream hiccup into an
 * unhandled rejection on the refresh path.
 */
export function classifyRefreshError(body: string, status = 0): RefreshFailure {
  let parsed: Record<string, any> | null = null;
  try {
    parsed = body ? JSON.parse(body) : null;
  } catch {
    parsed = null;
  }

  // Three shapes in the wild: `{error: "invalid_grant"}` (RFC 6749), `{error: {code: …}}` (Anthropic's
  // API errors), and `{error_code: …}`. Reading all three costs nothing and each one has been seen.
  const code = String(parsed?.error?.code ?? parsed?.error ?? parsed?.error_code ?? '');
  const description = String(
    parsed?.error_description ?? parsed?.error?.message ?? parsed?.message ?? body ?? '',
  ).slice(0, MAX_DESCRIPTION);

  const combined = `${code} ${description}`.toLowerCase();

  return {
    status,
    code,
    description,
    permanent: PERMANENT_MARKERS.some((marker) => combined.includes(marker)),
  };
}

/**
 * A refresh that did not produce a token, carrying why.
 *
 * Thrown rather than returned so the proactive path can ignore it with a bare `catch` while the
 * reactive path reads `permanent` off it. A plain `Error` would force the executor to re-parse a
 * message string to make that decision, which is how the classification drifts out of sync with the
 * thing that produced it.
 */
export class TokenRefreshError extends Error {
  readonly failure: RefreshFailure;

  constructor(failure: RefreshFailure) {
    super(
      failure.code
        ? `token refresh failed (${failure.status} ${failure.code}): ${failure.description}`
        : `token refresh failed (${failure.status}): ${failure.description}`,
    );
    this.name = 'TokenRefreshError';
    this.failure = failure;
  }

  get permanent(): boolean {
    return this.failure.permanent;
  }
}

/**
 * Whether an arbitrary thrown value means "sign in again".
 *
 * Takes `unknown` because it is called from a `catch`, where the value is not guaranteed to be an
 * Error at all. Anything that is not a `TokenRefreshError` is transient by construction — a thrown
 * `TypeError` from a broken fetch says nothing about the grant.
 */
export function isPermanentRefreshFailure(error: unknown): boolean {
  return error instanceof TokenRefreshError && error.permanent;
}
