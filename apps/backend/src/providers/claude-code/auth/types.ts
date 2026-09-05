import type { CredentialKind } from './credential';

/**
 * One Anthropic credential, and what the gateway has learned about it.
 *
 * Deliberately smaller than the Copilot and Antigravity account shapes. Those carry a device-flow
 * state machine, a token exchange and a fingerprint because their upstreams require one; this
 * credential is handed over whole by the operator, so everything here is either what they gave us or
 * what the upstream told us afterwards.
 */
export interface ClaudeCodeAccount {
  id: string;
  /** The secret. Never leaves this process, never enters a log line or an HTTP response. */
  credential: string;
  /** Derived from the credential, cached so the header path is not re-sniffing on every request. */
  kind: CredentialKind;
  /** Operator-facing name. Falls back to the fingerprint when they do not give one. */
  label: string;
  /** 0–1. Dropped on failure, recovered on success — the same currency every provider reports. */
  healthScore: number;
  lastUsed: number;
  consecutiveFailures: number;
  /**
   * The refresh token, when this account came from the OAuth flow.
   *
   * Its presence is what separates an account that can heal itself from one that cannot: an API key
   * and a pasted `setup-token` both sit in `credential` and simply expire, while an OAuth account
   * renews `credential` in place and keeps working.
   */
  refreshToken?: string;
  /** When `credential` stops working, epoch ms. Renewed ahead of this — see `CLAUDE_OAUTH.refreshLeadMs`. */
  expiresAt?: number;
  /** Set when a 401 says the credential is finished, so selection stops offering it. */
  invalidatedAt?: number;
  /** Why it was invalidated, in words the dashboard can show. */
  invalidReason?: string;
  /** Per-scope cooldown expiry, in epoch ms. Written by a 429. */
  cooldowns?: Record<string, number>;
  /** Last seen rate-limit snapshot, for the Quota tab. */
  rateLimit?: RateLimitSnapshot;
}

/**
 * What Anthropic's rate-limit headers said on the last response.
 *
 * Kept per account rather than per provider because two credentials on different plans have
 * genuinely different ceilings, and averaging them would describe neither.
 */
export interface RateLimitSnapshot {
  /** `anthropic-ratelimit-unified-status`: allowed | allowed_warning | rejected. */
  status?: string;
  remaining?: number;
  limit?: number;
  /** Epoch ms, converted from the header's RFC 3339 timestamp on the way in. */
  resetsAt?: number;
  observedAt: number;
}

export type SelectionStrategy = 'round-robin' | 'healthiest';
