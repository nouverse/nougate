/**
 * Dropping thinking blocks whose signature will not survive the upstream.
 *
 * A thinking block replayed from conversation history carries a signature Anthropic issued when it
 * produced the block. Send one back with a signature that is malformed — truncated by a client,
 * mangled by a store that round-tripped it through something lossy, or absent because the client
 * reconstructed the turn by hand — and the whole request is rejected. One bad block in a long history
 * fails every subsequent turn of that conversation, and the error names the block index rather than
 * the cause.
 *
 * `upstream/signature.ts` decides what "will not survive" means. This decides what to do about it.
 *
 * ## The conservative rule, and why it is not "drop every invalid block"
 *
 * When thinking is enabled, Anthropic requires an assistant turn containing `tool_use` to *open* with
 * a thinking block. So stripping the only thinking block from such a message trades one rejection for
 * another — and the second is harder to read, because the request that fails no longer resembles the
 * one the client sent.
 *
 * The reference implementation resolves this by substituting a known-good signature captured from a
 * real session. That works, and it is not done here: a signature is an assertion by Anthropic about
 * content it generated, and pasting one onto a different block makes the request assert something
 * nobody checked. See invariant 5 — a value indistinguishable from a real one, that is not one, is
 * exactly what this codebase does not ship.
 *
 * So: an assistant message carrying `tool_use` is left exactly as it arrived. If its signature really
 * is bad the upstream says so, and the error points at the block the client actually sent. Everywhere
 * else an unusable thinking block is dropped, because there it is pure gain — the turn proceeds
 * without the content that would have failed it.
 */

import { isValidClaudeSignature } from '../upstream/signature';

/** The two block types that carry a signature. `redacted_thinking` is signed the same way. */
const THINKING_BLOCKS = new Set(['thinking', 'redacted_thinking']);

/**
 * Strip thinking blocks that cannot be replayed.
 *
 * Returns the original object when nothing changed, so a body with no history — the common case —
 * costs one scan and no allocation, and a caller can compare by identity to tell whether it acted.
 */
export function dropUnusableThinking(body: any): any {
  if (!Array.isArray(body?.messages)) return body;

  let changed = false;

  const messages = body.messages.map((message: any) => {
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) return message;

    // Left whole rather than turned into the "tool_use with no thinking" rejection.
    if (message.content.some((block: any) => block?.type === 'tool_use')) return message;

    const kept = message.content.filter(
      (block: any) => !THINKING_BLOCKS.has(block?.type) || isValidClaudeSignature(block?.signature),
    );
    if (kept.length === message.content.length) return message;

    changed = true;
    return { ...message, content: kept };
  });

  return changed ? { ...body, messages } : body;
}
