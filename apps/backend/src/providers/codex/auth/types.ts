/**
 * One Codex (OpenAI) credential, and what the gateway has learned about it.
 *
 * Carries an OAuth access token, refresh token, id_token (for ChatGPT account ID extraction),
 * and staleness tracking (`lastRefreshAt`) for proactive refresh within `maxRefreshAgeMs`.
 */
export interface CodexAccount {
  id: string;
  /** OAuth access token — the bearer credential for upstream requests. */
  accessToken: string;
  /** OAuth refresh token — used to renew the access token. */
  refreshToken: string;
  /** The raw id_token JWT, from which `chatgptAccountId` is decoded. */
  idToken?: string;
  /** Decoded from `id_token` JWT claim `https://api.openai.com/auth.chatgpt_account_id`. */
  chatgptAccountId?: string;
  /** Operator-facing name. Falls back to a fingerprint when not given. */
  label: string;
  /** 0–100. Dropped on failure, recovered on success. */
  healthScore: number;
  lastUsed: number;
  consecutiveFailures: number;
  /** When the access token expires, epoch ms. */
  expiresAt?: number;
  /** When the last refresh happened, epoch ms. Used for proactive stale refresh. */
  lastRefreshAt?: number;
  /** Set when a 401 says the credential is finished. */
  invalidatedAt?: number;
  /** Why it was invalidated. */
  invalidReason?: string;
  /** Per-scope cooldown expiry, in epoch ms. */
  cooldowns?: Record<string, number>;
}

export type SelectionStrategy = 'round-robin' | 'healthiest';
