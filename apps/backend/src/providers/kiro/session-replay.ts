/**
 * Keeping Kiro's prompt cache warm across the turns of one conversation.
 *
 * Kiro caches on the exact bytes of the conversation prefix. Two things in a naive payload would
 * change those bytes on every turn:
 *
 *   - the system prompt travels inside the first user turn (Kiro refuses a top-level
 *     `systemPrompt`), so it has to be prefixed onto that turn's content; and
 *   - the current time is injected so the model knows it, and it differs every request.
 *
 * So the first user message — system prompt and all — is frozen the first time a conversation is
 * seen, and replayed byte-identically as the first history entry on every later turn. The time goes
 * only into the *current* turn, which is never part of a cached prefix anyway.
 *
 * A frozen start is only reused while the model and system prompt are unchanged; either changing
 * invalidates the cache upstream, so it is re-frozen.
 */

import { randomUUID } from 'node:crypto';

export interface KiroUserInputMessage {
  content: string;
  modelId?: string;
  origin?: string;
  images?: Array<{ format: string; source: { bytes: string } }>;
  userInputMessageContext?: {
    toolResults?: Array<{ toolUseId: string; status: 'success' | 'error'; content: Array<{ text: string }> }>;
    tools?: unknown[];
  };
}

export interface KiroAssistantResponseMessage {
  content: string;
  toolUses?: Array<{ toolUseId: string; name: string; input: unknown }>;
}

export type KiroTurn =
  | { userInputMessage: KiroUserInputMessage; assistantResponseMessage?: undefined }
  | { assistantResponseMessage: KiroAssistantResponseMessage; userInputMessage?: undefined };

export type KiroUserTurn = { userInputMessage: KiroUserInputMessage; assistantResponseMessage?: undefined };

const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 5000;

interface SessionStart {
  sessionStart: KiroUserTurn;
  modelId: string;
  systemPrompt: string;
  lastUsed: number;
}

const store = new Map<string, SessionStart>();

const cleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store) if (now - entry.lastUsed > SESSION_TTL_MS) store.delete(key);
}, CLEANUP_INTERVAL_MS);
cleanup.unref?.();

function clone<T>(value: T): T {
  return value == null ? value : structuredClone(value);
}

function withModelId<T extends KiroTurn>(turn: T, modelId: string): T {
  if (turn.userInputMessage && !turn.userInputMessage.modelId) turn.userInputMessage.modelId = modelId;
  return turn;
}

function prefixed(turn: KiroUserTurn | undefined, prefix: string, modelId: string): KiroUserTurn {
  const out: KiroUserTurn = clone(turn) ?? { userInputMessage: { content: '' } };
  withModelId(out, modelId);
  if (prefix) {
    const content = out.userInputMessage.content || '';
    out.userInputMessage.content = content ? `${prefix}\n\n${content}` : prefix;
  }
  return out;
}

/** A history whose first entry is a plain user turn can have that turn swapped for the frozen one. */
function canReplaceStart(history: KiroTurn[]): boolean {
  const first = history[0];
  return Boolean(first?.userInputMessage && !first.userInputMessage.userInputMessageContext?.toolResults?.length);
}

function remember(key: string, entry: Omit<SessionStart, 'lastUsed'>): void {
  if (store.size >= MAX_SESSIONS) store.delete(store.keys().next().value!);
  store.set(key, { ...entry, lastUsed: Date.now() });
}

export interface SessionReplayInput {
  conversationId: string;
  /** Scopes the store per account: a cached prefix belongs to one credential. */
  accountId: string;
  modelId: string;
  /** Cache key only — what the frozen start was built from. */
  systemPrompt: string;
  /** Prepended to the first user turn the first time: system prompt plus time. */
  contentPrefix: string;
  /** Prepended to the current turn every time: the time alone. */
  currentContentPrefix: string;
  history: KiroTurn[];
  currentMessage: KiroUserTurn;
  /** When false, the prefix is applied but nothing is frozen or replayed. */
  enabled: boolean;
}

export function applySessionReplay(input: SessionReplayInput): {
  history: KiroTurn[];
  currentMessage: KiroUserTurn;
  replayed: boolean;
} {
  const { modelId } = input;
  const key = `${input.accountId}:${input.conversationId}`;
  const history = clone(input.history) ?? [];
  const current = clone(input.currentMessage);
  const existing = input.enabled ? store.get(key) : undefined;

  if (existing && existing.modelId === modelId && existing.systemPrompt === input.systemPrompt) {
    existing.lastUsed = Date.now();
    const start = withModelId(clone(existing.sessionStart), modelId);
    if (canReplaceStart(history)) {
      history[0] = start;
    } else {
      history.unshift(start);
      if (history.length === 1) history.push({ assistantResponseMessage: { content: '...' } });
    }
    for (const turn of history) withModelId(turn, modelId);
    return { history, currentMessage: prefixed(current, input.currentContentPrefix, modelId), replayed: true };
  }

  let sessionStart: KiroUserTurn;
  let nextCurrent: KiroUserTurn;
  const firstUser = history.findIndex((turn) => turn.userInputMessage);

  if (canReplaceStart(history)) {
    sessionStart = prefixed(history[0] as KiroUserTurn, input.contentPrefix, modelId);
    history[0] = clone(sessionStart);
    nextCurrent = prefixed(current, input.currentContentPrefix, modelId);
  } else if (firstUser >= 0) {
    sessionStart = prefixed({ userInputMessage: { content: '', modelId } }, input.contentPrefix, modelId);
    history.unshift(clone(sessionStart));
    nextCurrent = prefixed(current, input.currentContentPrefix, modelId);
  } else {
    // First turn of the conversation: it is the start, and carries the full prefix.
    sessionStart = prefixed(current, input.contentPrefix, modelId);
    nextCurrent = clone(sessionStart);
  }

  if (input.enabled) {
    remember(key, { sessionStart: clone(sessionStart), modelId, systemPrompt: input.systemPrompt });
  }
  for (const turn of history) withModelId(turn, modelId);
  return { history, currentMessage: nextCurrent, replayed: false };
}

export function clearSessionReplayStore(): void {
  store.clear();
}

// ─── Conversation identity ─────────────────────────────────────────────────

const SESSION_HEADERS = ['x-session-id', 'session-id', 'session_id', 'x-amp-thread-id'];
const CLAUDE_CODE_SESSION = /_session_([a-f0-9-]+)$/;

function normalizeId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= 256 ? trimmed : null;
}

function claudeCodeSession(userId: unknown): string | null {
  if (typeof userId !== 'string' || !userId) return null;
  const match = userId.match(CLAUDE_CODE_SESSION);
  if (match) return match[1]!;
  if (userId.startsWith('{')) {
    try {
      return normalizeId(JSON.parse(userId)?.session_id);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * The conversation id a client stated, if any — never a guess.
 *
 * Claude Code puts its session in `metadata.user_id` and in a header; other clients use one of the
 * common session headers or body fields. When none is present the request is one-shot: a fresh id,
 * and replay has nothing to match on later. Hashing message text to invent a stable id (as some
 * gateways do) would merge two users' identical first prompts into one cached prefix.
 */
export function resolveConversationId(headers: Headers | null, body: any): { conversationId: string; ephemeral: boolean } {
  const claude = claudeCodeSession(body?.metadata?.user_id) ?? normalizeId(headers?.get('x-claude-code-session-id'));
  if (claude) return { conversationId: `claude:${claude}`, ephemeral: false };

  for (const name of SESSION_HEADERS) {
    const value = normalizeId(headers?.get(name));
    if (value) return { conversationId: value, ephemeral: false };
  }

  const fromBody = normalizeId(body?.prompt_cache_key) ?? normalizeId(body?.session_id) ?? normalizeId(body?.conversation_id);
  if (fromBody) return { conversationId: fromBody, ephemeral: false };

  return { conversationId: `${randomUUID()}${Date.now()}`, ephemeral: true };
}
