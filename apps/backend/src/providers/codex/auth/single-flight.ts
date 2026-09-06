/**
 * One call at a time per key, and a brief memory of the answer.
 *
 * Prevents concurrent refresh-token usage that would trigger `refresh_token_reused`
 * revocation at OpenAI's auth server.
 */

interface Settled<T> {
  value: T;
  expiresAt: number;
}

export interface SingleFlight<T> {
  run(key: string, fn: () => Promise<T>): Promise<T>;
  forget(key: string): void;
  clear(): void;
}

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
          settled.delete(key);
          throw error;
        } finally {
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
