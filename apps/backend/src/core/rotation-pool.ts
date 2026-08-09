/**
 * Deployment-wide cap on how many accounts a provider may rotate through.
 *
 * A pod running a large account pool behind one egress IP looks, from upstream,
 * like one machine cycling through dozens of identities. `MAX_ACCOUNT_MULTIPLEXING`
 * bounds the working set so only the top N ranked accounts ever see traffic.
 *
 * Unset means uncapped — the behaviour every existing deployment already has.
 * There is no built-in default on purpose: silently benching accounts an
 * operator added is not something an upgrade should do on its own.
 */

/**
 * Read the cap from the environment, or null when it is not configured.
 *
 * Read on every call rather than cached at import, so the value is always the
 * live environment.
 */
export function getMaxAccountMultiplexing(): number | null {
  const raw = process.env.MAX_ACCOUNT_MULTIPLEXING;

  if (raw === undefined || raw.trim() === '') {
    return null;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    console.warn(
      `[Rotation] Ignoring MAX_ACCOUNT_MULTIPLEXING="${raw}" — expected a whole number of 1 or more.`,
    );
    return null;
  }

  return parsed;
}

/**
 * Trim an already-ranked candidate list to the configured cap.
 *
 * The list must be sorted best-first: this takes the head, so ranking is the
 * caller's job and the cap never changes which account is preferred — only how
 * far down the list a request is allowed to fall.
 */
export function capRotationPool<T>(ranked: T[]): T[] {
  const cap = getMaxAccountMultiplexing();

  if (cap === null || ranked.length <= cap) {
    return ranked;
  }

  return ranked.slice(0, cap);
}
