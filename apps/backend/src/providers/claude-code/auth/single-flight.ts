/**
 * One call at a time per key, and a brief memory of the answer.
 *
 * This exists for one specific failure, and it is the worst one on this provider's auth path.
 *
 * Anthropic **rotates** refresh tokens: a successful refresh returns a new refresh token and
 * invalidates the one that was sent. So two requests that notice the same expiring credential at the
 * same moment do not merely waste a round trip — the second one presents a token the first has
 * already spent, the server answers `refresh_token_reused`, and the *entire grant family* is
 * revoked. The account then fails permanently, minutes after a refresh that worked.
 *
 * That race is not hypothetical on a gateway. It is the normal case: a burst of concurrent requests
 * is exactly what a proxy is for, and they all consult the same account state and all see the same
 * expiry at once.
 *
 * ## Why the result is cached, and not only the in-flight promise
 *
 * De-duplicating the in-flight call closes the window while the refresh is running. It does not close
 * the one immediately after: a request that arrives a millisecond after the first refresh settled
 * reads the account it was handed at selection time — the copy with the *old* expiry — decides a
 * refresh is due, and sends the token that was just rotated away. A short memory of the result covers
 * that gap, and ten seconds is comfortably longer than it takes the write to land.
 *
 * ## Why failures are not cached
 *
 * A cached failure would suppress a retry that might have worked, and the cost asymmetry runs the
 * other way here: retrying a genuinely dead token costs one HTTP 400, while caching a transient
 * failure blocks recovery for the whole TTL. So a rejection clears the key and the next caller tries
 * again for real.
 */

interface Settled<T> {
  value: T;
  expiresAt: number;
}

export interface SingleFlight<T> {
  /** Run `fn` for `key`, or join whatever is already running or just finished for it. */
  run(key: string, fn: () => Promise<T>): Promise<T>;
  /** Forget `key` entirely. For tests, and for a caller that knows the cached answer is now wrong. */
  forget(key: string): void;
  /** Forget everything. Test seam — the maps are process-lifetime otherwise. */
  clear(): void;
}

/**
 * Build a single-flight gate.
 *
 * Generic over the result rather than hard-coded to a token response, because the usage endpoint
 * needs exactly the same treatment for a different reason (a shared 429 budget) and two copies of
 * this logic would drift.
 *
 * @param ttlMs How long a settled result answers subsequent calls. Not a cache in any general sense —
 *   it is the width of the race window this is closing, and it should stay small enough that a caller
 *   never receives a token it could have refreshed instead.
 */
export function createSingleFlight<T>(ttlMs: number): SingleFlight<T> {
  const inFlight = new Map<string, Promise<T>>();
  const settled = new Map<string, Settled<T>>();

  return {
    async run(key: string, fn: () => Promise<T>): Promise<T> {
      const running = inFlight.get(key);
      if (running) return running;

      const recent = settled.get(key);
      if (recent) {
        if (recent.expiresAt > Date.now()) return recent.value;
        settled.delete(key);
      }

      const promise = (async () => {
        try {
          const value = await fn();
          settled.set(key, { value, expiresAt: Date.now() + ttlMs });
          return value;
        } catch (error) {
          // Deliberately not remembered — see the note on failures above.
          settled.delete(key);
          throw error;
        } finally {
          // In `finally` rather than in both branches: an early `return` inside the try would
          // otherwise leave the key marked as running forever, and every later caller would await a
          // promise that has already settled.
          inFlight.delete(key);
        }
      })();

      inFlight.set(key, promise);
      return promise;
    },

    forget(key: string): void {
      inFlight.delete(key);
      settled.delete(key);
    },

    clear(): void {
      inFlight.clear();
      settled.clear();
    },
  };
}
