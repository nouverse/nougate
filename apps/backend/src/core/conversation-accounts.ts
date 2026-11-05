/**
 * The account that last answered each conversation, so the conversation's next request goes back to it.
 *
 * An upstream's prompt cache belongs to one account: Anthropic's to the account, OpenAI's to the organization, and a
 * Claude Code or Codex sign-in is one of each. Choosing the healthiest account with the least recently used as the
 * tiebreak sent each request of a conversation to the next account, and every one of them wrote the conversation's
 * prefix into a cache of its own: a write where the account before would have charged a read. A conversation stays
 * with its account while that account can answer. One that is cooling, invalidated, removed or already tried in this
 * request is not among the usable, and the account that answers instead keeps the conversation from then on.
 *
 * In memory: a restart forgets them all, which costs each conversation one more write.
 */

/**
 * An hour after the last answer: the longest Anthropic keeps a cache entry, and the longest OpenAI does unless
 * asked for more. Past it there is seldom anything to go back to, and the strategy chooses again.
 */
const KEPT_MS = 60 * 60_000;

/**
 * A bound, so a flood of one-off requests cannot grow the map without end; past it the oldest is forgotten. Each
 * entry is a key and an id, a few hundred bytes (estimated), so the whole map stays a few megabytes.
 */
const KEPT_AT_MOST = 10_000;

export class ConversationAccounts {
  private readonly answered = new Map<string, { accountId: string; at: number }>();

  /**
   * `accountId` answered `conversation`. Deleted before it is set, so the map's order is the order of the last
   * answers and its first key is always the oldest: the one dropped when the map is full.
   */
  remember(conversation: string, accountId: string, now = Date.now()): void {
    this.answered.delete(conversation);
    this.answered.set(conversation, { accountId, at: now });
    if (this.answered.size > KEPT_AT_MOST) {
      const oldest = this.answered.keys().next().value;
      if (oldest !== undefined) this.answered.delete(oldest);
    }
  }

  /** The account that answered `conversation` last, when it is among `usable` and answered within the hour. */
  keptAmong<T extends { id: string }>(conversation: string | undefined, usable: readonly T[], now = Date.now()): T | undefined {
    if (!conversation) return undefined;
    const kept = this.answered.get(conversation);
    if (!kept || now - kept.at >= KEPT_MS) return undefined;
    return usable.find((account) => account.id === kept.accountId);
  }
}
