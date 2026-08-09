/**
 * Anti-fingerprinting request jitter, shared by every provider.
 *
 * Providers used to each own a private copy of these three fields and their own
 * `min + random * (max - min)` block next to `fetch`. That made the delay
 * unenforceable: a deployment could not state a minimum spacing without editing
 * every provider, and a new provider could ship with no jitter at all and
 * nothing would notice.
 *
 * So the shape lives here, `getJitterConfig()` is a required member of
 * `IProvider`, and the sleep happens once in `executeProviderRequest`.
 */

/**
 * How long to wait before a request goes upstream.
 *
 * A window rather than a fixed delay: a constant sleep is itself a fingerprint.
 */
export interface JitterConfig {
  jitterEnabled: boolean;
  jitterMinMs: number;
  jitterMaxMs: number;
}

/**
 * What a provider gets when it expresses no preference. Deliberately non-zero —
 * a provider that forgets to think about jitter should still be spaced out.
 */
export const DEFAULT_JITTER_CONFIG: JitterConfig = {
  jitterEnabled: true,
  jitterMinMs: 1000,
  jitterMaxMs: 3000,
};

/** The resolved window actually used for one request. */
export interface JitterWindow {
  minMs: number;
  maxMs: number;
}

/**
 * Read the deployment-wide jitter floor from the environment.
 *
 * Unset (or blank) means no floor and no clamping at all: providers get exactly
 * the window they asked for. Read on every call rather than cached at import so
 * the value is always the live environment.
 */
export function getBottomJitterMs(): number | null {
  const raw = process.env.BOTTOM_JITTER ?? process.env.BOTTOM_JITTER_MS;

  if (raw === undefined || raw.trim() === '') {
    return null;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.warn(
      `[Jitter] Ignoring BOTTOM_JITTER="${raw}" — expected a non-negative number of milliseconds.`,
    );
    return null;
  }

  return Math.floor(parsed);
}

/**
 * Fill in whatever a caller left out, and make the window coherent.
 */
export function normalizeJitterConfig(config: Partial<JitterConfig> | null | undefined): JitterConfig {
  const enabled = config?.jitterEnabled ?? DEFAULT_JITTER_CONFIG.jitterEnabled;
  const minMs = Math.max(0, config?.jitterMinMs ?? DEFAULT_JITTER_CONFIG.jitterMinMs);
  const maxMs = Math.max(minMs, config?.jitterMaxMs ?? DEFAULT_JITTER_CONFIG.jitterMaxMs);

  return { jitterEnabled: enabled, jitterMinMs: minMs, jitterMaxMs: maxMs };
}

/**
 * Apply the deployment floor to a provider's own window.
 *
 * Returns null when no delay should happen at all.
 *
 * The floor also overrides `jitterEnabled: false`. Anything less would make the
 * floor advisory: a provider could opt out of a limit the operator set for the
 * whole pod, which is the exact thing it exists to prevent.
 */
export function resolveJitterWindow(config: Partial<JitterConfig> | null | undefined): JitterWindow | null {
  const normalized = normalizeJitterConfig(config);
  const floor = getBottomJitterMs();

  if (floor === null) {
    return normalized.jitterEnabled ? { minMs: normalized.jitterMinMs, maxMs: normalized.jitterMaxMs } : null;
  }

  if (floor === 0 && !normalized.jitterEnabled) {
    return null;
  }

  const minMs = Math.max(normalized.jitterMinMs, floor);
  return { minMs, maxMs: Math.max(normalized.jitterMaxMs, minMs) };
}

/**
 * Sleep for a random duration inside the resolved window.
 *
 * Returns the milliseconds actually waited, which is what the tests assert on.
 */
export async function applyJitter(config: Partial<JitterConfig> | null | undefined): Promise<number> {
  const window = resolveJitterWindow(config);

  if (!window || window.maxMs <= 0) {
    return 0;
  }

  const delayMs = window.minMs + Math.random() * (window.maxMs - window.minMs);
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  return delayMs;
}
