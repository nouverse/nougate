/**
 * Shaping a conversation into what Kiro's `GenerateAssistantResponse` accepts.
 *
 * Kiro is strict where clients are loose, and anything it dislikes is a bare
 * `400 Improperly formed request` with no hint which turn was wrong. Its rules:
 *
 *   - turns strictly alternate, starting and ending with a user turn;
 *   - an assistant turn's tool uses are answered one-to-one, by id, in the very next user turn;
 *   - every tool use names a tool declared in the current turn's specs;
 *   - tool and tool-use ids match `[a-zA-Z0-9_-]{1,64}`, names `[a-zA-Z0-9_-]{1,64}`;
 *   - no user turn has empty content.
 *
 * Clients break these routinely — compaction drops a tool result, a parallel call is half-answered,
 * an MCP tool is named `mcp__server__tool` — so the conversation is repaired rather than refused:
 * an unpairable tool exchange is flattened into text both sides can still read. Only when even the
 * fully flattened form is invalid is the request refused, locally, without spending an upstream call.
 */

import type { KiroAssistantResponseMessage, KiroTurn, KiroUserInputMessage, KiroUserTurn } from '../session-replay';

export const KIRO_TOOL_NAME_MAX_LENGTH = 64;
export const KIRO_TOOL_DESCRIPTION_MAX_LENGTH = 10_237;
export const KIRO_TOOL_ID_MAX_LENGTH = 64;

/**
 * Placeholder for a user turn that only carries tool results. It must not read as an instruction:
 * with "continue", models answer the word itself and drop the task they were in.
 */
export const KIRO_TOOL_RESULTS_PLACEHOLDER = 'Tool results provided.';
export const KIRO_EMPTY_USER_PLACEHOLDER = 'continue';

export function emptyUserContent(hasToolResults: boolean): string {
  return hasToolResults ? KIRO_TOOL_RESULTS_PLACEHOLDER : KIRO_EMPTY_USER_PLACEHOLDER;
}

const TOOL_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const TOOL_NAME_INVALID = /[^a-zA-Z0-9_-]/g;

export interface KiroToolSpec {
  toolSpecification: {
    name: string;
    description: string;
    inputSchema: { json: Record<string, unknown> };
  };
}

type ToolResult = NonNullable<NonNullable<KiroUserInputMessage['userInputMessageContext']>['toolResults']>[number];
type ToolUse = NonNullable<KiroAssistantResponseMessage['toolUses']>[number];

function clone<T>(value: T): T {
  return value == null ? value : structuredClone(value);
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function appendText(target: { content: string }, extra: string): void {
  if (!extra) return;
  target.content = target.content ? `${target.content}\n\n${extra}` : extra;
}

/** Trim by code point, so a name is never cut through a surrogate pair. */
function trimCodePoints(value: string, limit: number): string {
  return [...value].slice(0, limit).join('');
}

function uniqueName(rawName: string, index: number, used: Set<string>): string {
  const cleaned = rawName.trim().replace(TOOL_NAME_INVALID, '_').replace(/^_+|_+$/g, '');
  const base = trimCodePoints(cleaned || `tool_${index + 1}`, KIRO_TOOL_NAME_MAX_LENGTH);
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    const tail = `_${suffix++}`;
    candidate = `${base.slice(0, KIRO_TOOL_NAME_MAX_LENGTH - tail.length)}${tail}`;
  }
  used.add(candidate);
  return candidate;
}

/** Kiro rejects `additionalProperties` and empty `required` arrays anywhere in a schema. */
function cleanSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cleanSchema);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'additionalProperties') continue;
    if (key === 'required' && Array.isArray(child) && child.length === 0) continue;
    out[key] = cleanSchema(child);
  }
  return out;
}

function normalizeRootSchema(schema: unknown): Record<string, unknown> {
  const cleaned = cleanSchema(schema && typeof schema === 'object' ? clone(schema) : {}) as Record<string, any>;
  cleaned.type = 'object';
  if (!cleaned.properties || typeof cleaned.properties !== 'object' || Array.isArray(cleaned.properties)) {
    cleaned.properties = {};
  }
  if (Array.isArray(cleaned.required)) {
    const required = [
      ...new Set(cleaned.required.filter((name: unknown) => typeof name === 'string' && Object.hasOwn(cleaned.properties, name))),
    ];
    if (required.length > 0) cleaned.required = required;
    else delete cleaned.required;
  }
  return cleaned;
}

/**
 * Kiro tool specs from OpenAI (`{type:'function', function:{…}}`) or Anthropic (`{name,
 * input_schema}`) definitions, plus the map from the client's tool names to the sanitised ones.
 * The reverse of that map is what lets a tool call stream back under the name the client declared.
 */
export function normalizeToolSpecs(tools: unknown): { specs: KiroToolSpec[]; nameMap: Map<string, string> } {
  const specs: KiroToolSpec[] = [];
  const nameMap = new Map<string, string>();
  const used = new Set<string>();

  for (const [index, tool] of (Array.isArray(tools) ? tools : []).entries()) {
    if (!tool || typeof tool !== 'object') continue;
    const rawName = tool.function?.name ?? tool.name;
    if (typeof rawName !== 'string' || !rawName.trim()) continue;
    // A repeated definition with the same source name describes the same tool.
    if (nameMap.has(rawName)) continue;
    const name = uniqueName(rawName, index, used);
    nameMap.set(rawName, name);

    const rawDescription = tool.function?.description ?? tool.description ?? `Tool: ${rawName}`;
    specs.push({
      toolSpecification: {
        name,
        description: trimCodePoints(String(rawDescription || `Tool: ${rawName}`), KIRO_TOOL_DESCRIPTION_MAX_LENGTH),
        inputSchema: { json: normalizeRootSchema(tool.function?.parameters ?? tool.parameters ?? tool.input_schema ?? {}) },
      },
    });
  }
  return { specs, nameMap };
}

/** Sanitised name → client name, for tool calls coming back. Identity entries are omitted. */
export function reverseToolNames(nameMap: Map<string, string>): Map<string, string> {
  const reverse = new Map<string, string>();
  for (const [original, sanitized] of nameMap) if (original !== sanitized) reverse.set(sanitized, original);
  return reverse;
}

function toolCallText(call: { name?: string; input?: unknown }): string {
  return `[Tool call: ${call.name || 'unknown'}(${asText(call.input ?? {})})]`;
}

function toolResultText(result: ToolResult): string {
  const content = Array.isArray(result.content)
    ? result.content.map((part) => asText(part?.text ?? part)).filter(Boolean).join('\n')
    : asText(result.content);
  return `[Tool result${result.status === 'error' ? ' (error)' : ''}: ${content}]`;
}

function mergeUser(target: KiroUserInputMessage, source: KiroUserInputMessage): void {
  appendText(target, source.content);
  if (source.images?.length) target.images = [...(target.images ?? []), ...source.images];
  const results = source.userInputMessageContext?.toolResults;
  if (results?.length) {
    target.userInputMessageContext ??= {};
    target.userInputMessageContext.toolResults = [...(target.userInputMessageContext.toolResults ?? []), ...results];
  }
}

function mergeAssistant(target: KiroAssistantResponseMessage, source: KiroAssistantResponseMessage): void {
  appendText(target, source.content);
  if (source.toolUses?.length) target.toolUses = [...(target.toolUses ?? []), ...source.toolUses];
}

/** Merge same-role neighbours, pad the ends with user turns, fill empty content. */
function normalizeTurns(history: KiroTurn[], current: KiroUserTurn | null, modelId: string): KiroTurn[] {
  const raw = [...history, ...(current ? [current] : [])];
  const turns: KiroTurn[] = [];

  for (const entry of raw) {
    const isUser = Boolean(entry?.userInputMessage);
    const isAssistant = Boolean(entry?.assistantResponseMessage);
    if (isUser === isAssistant) continue;
    const turn: KiroTurn = isUser
      ? { userInputMessage: clone(entry.userInputMessage!) }
      : { assistantResponseMessage: clone(entry.assistantResponseMessage!) };
    const previous = turns[turns.length - 1];
    if (turn.userInputMessage && previous?.userInputMessage) mergeUser(previous.userInputMessage, turn.userInputMessage);
    else if (turn.assistantResponseMessage && previous?.assistantResponseMessage) {
      mergeAssistant(previous.assistantResponseMessage, turn.assistantResponseMessage);
    } else turns.push(turn);
  }

  if (turns[0]?.assistantResponseMessage) turns.unshift({ userInputMessage: { content: 'continue', modelId } });
  if (turns.length === 0 || turns[turns.length - 1]?.assistantResponseMessage) {
    turns.push({ userInputMessage: { content: 'continue', modelId } });
  }

  for (const turn of turns) {
    if (turn.userInputMessage) {
      const user = turn.userInputMessage;
      user.content =
        asText(user.content).trim() || emptyUserContent(Boolean(user.userInputMessageContext?.toolResults?.length));
      user.modelId ||= modelId;
      if (user.userInputMessageContext?.tools) delete user.userInputMessageContext.tools;
    } else {
      turn.assistantResponseMessage.content = asText(turn.assistantResponseMessage.content).trim() || '...';
    }
  }
  return turns;
}

function rawId(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** A Kiro-legal, unique id for a tool use: the client's when it is legal, else a derived one. */
function reserveToolId(value: unknown, turnIndex: number, callIndex: number, name: string, used: Set<string>): string {
  const sanitized = rawId(value).replace(/[^a-zA-Z0-9_-]/g, '');
  const generated = `call_msg${turnIndex}_tc${callIndex}_${name || 'tool'}`;
  const base = trimCodePoints(TOOL_ID_PATTERN.test(sanitized) && sanitized ? sanitized : generated, KIRO_TOOL_ID_MAX_LENGTH);
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    const tail = `_${suffix++}`;
    candidate = `${base.slice(0, KIRO_TOOL_ID_MAX_LENGTH - tail.length)}${tail}`;
  }
  used.add(candidate);
  return candidate;
}

/** A tool input as an object, or `null` when it is not one and the call cannot be replayed. */
function normalizeToolInput(input: unknown): Record<string, unknown> | null {
  if (input && typeof input === 'object' && !Array.isArray(input)) return clone(input as Record<string, unknown>);
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return input == null ? {} : null;
}

function normalizeToolResult(result: any): ToolResult {
  const content = Array.isArray(result?.content)
    ? result.content.map((part: any) => ({ text: asText(part?.text ?? part) }))
    : [{ text: asText(result?.content) }];
  return {
    toolUseId: rawId(result?.toolUseId),
    status: result?.status === 'error' ? 'error' : 'success',
    content: content.length > 0 ? content : [{ text: '' }],
  };
}

function flattenResults(user: KiroUserInputMessage, results: ToolResult[]): void {
  for (const result of results) appendText(user, toolResultText(result));
}

function cleanUserContext(user: KiroUserInputMessage): void {
  const context = user.userInputMessageContext;
  if (!context) return;
  if (!context.toolResults?.length) delete context.toolResults;
  if (!context.tools?.length) delete context.tools;
  if (Object.keys(context).length === 0) delete user.userInputMessageContext;
}

export interface ConversationRepairs {
  missingResults: number;
  orphanResults: number;
  invalidToolUses: number;
}

/** Pair one assistant turn's calls with the next user turn's results; flatten what will not pair. */
function reconcileToolPair(
  assistant: KiroAssistantResponseMessage,
  user: KiroUserInputMessage,
  turnIndex: number,
  nameMap: Map<string, string>,
  specNames: Set<string>,
  usedIds: Set<string>,
  repairs: ConversationRepairs,
): void {
  const calls = assistant.toolUses ?? [];
  const results = (user.userInputMessageContext?.toolResults ?? []).map(normalizeToolResult);

  if (calls.length === 0) {
    if (results.length > 0) {
      flattenResults(user, results);
      repairs.orphanResults += results.length;
    }
    if (user.userInputMessageContext) delete user.userInputMessageContext.toolResults;
    cleanUserContext(user);
    return;
  }

  const queues = new Map<string, Array<{ call: ToolUse; callIndex: number; key: string; name: string; input: Record<string, unknown> | null; result: ToolResult | null }>>();
  const records = calls.map((call, callIndex) => {
    const key = rawId(call?.toolUseId);
    const record = {
      call,
      callIndex,
      key,
      name: nameMap.get(call?.name) || call?.name,
      input: normalizeToolInput(call?.input),
      result: null as ToolResult | null,
    };
    const queue = queues.get(key) ?? [];
    queue.push(record);
    queues.set(key, queue);
    return record;
  });

  const orphans: ToolResult[] = [];
  for (const result of results) {
    const record = queues.get(rawId(result.toolUseId))?.find((candidate) => !candidate.result);
    if (record) record.result = result;
    else orphans.push(result);
  }

  const keptCalls: ToolUse[] = [];
  const keptResults: ToolResult[] = [];
  for (const record of records) {
    const hasSpec = typeof record.name === 'string' && specNames.has(record.name);
    if (!record.result || !hasSpec || record.input === null) {
      appendText(assistant, toolCallText({ name: record.name, input: record.call?.input }));
      repairs.missingResults += record.result ? 0 : 1;
      repairs.invalidToolUses += hasSpec && record.input !== null ? 0 : 1;
      if (record.result) {
        flattenResults(user, [record.result]);
        repairs.orphanResults++;
      }
      continue;
    }
    const toolUseId = reserveToolId(record.key, turnIndex, record.callIndex, record.name, usedIds);
    keptCalls.push({ toolUseId, name: record.name, input: record.input });
    keptResults.push({ ...record.result, toolUseId });
  }

  if (orphans.length > 0) {
    flattenResults(user, orphans);
    repairs.orphanResults += orphans.length;
  }

  if (keptCalls.length > 0) assistant.toolUses = keptCalls;
  else delete assistant.toolUses;
  user.userInputMessageContext ??= {};
  if (keptResults.length > 0) user.userInputMessageContext.toolResults = keptResults;
  else delete user.userInputMessageContext.toolResults;
  cleanUserContext(user);
}

/**
 * Validate a final wire conversation without changing it. Error codes name the offending turn —
 * `role:N`, `pair:N`, `id:N`, `spec:N`, `orphan:0`, `current` — so a refusal is diagnosable from
 * the log line alone.
 */
export function validateConversation(
  history: KiroTurn[],
  current: KiroUserTurn | null,
  toolSpecs: KiroToolSpec[] = [],
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const turns = [...history, ...(current ? [current] : [])];
  const specNames = new Set(toolSpecs.map((spec) => spec.toolSpecification.name));
  const usedIds = new Set<string>();

  turns.forEach((turn, index) => {
    const isUser = Boolean(turn.userInputMessage);
    if (isUser !== (index % 2 === 0)) errors.push(`role:${index}`);
    if (!isUser) {
      const calls = turn.assistantResponseMessage?.toolUses ?? [];
      const results = turns[index + 1]?.userInputMessage?.userInputMessageContext?.toolResults ?? [];
      const resultIds = results.map((result) => result.toolUseId);
      if (calls.length !== results.length || calls.some((call) => !resultIds.includes(call.toolUseId))) {
        errors.push(`pair:${index}`);
      }
      for (const call of calls) {
        if (!call.toolUseId || usedIds.has(call.toolUseId)) errors.push(`id:${index}`);
        usedIds.add(call.toolUseId);
        if (!specNames.has(call.name)) errors.push(`spec:${index}`);
      }
    } else if (index === 0 && turn.userInputMessage?.userInputMessageContext?.toolResults?.length) {
      errors.push('orphan:0');
    }
  });
  if (!current?.userInputMessage?.content) errors.push('current');
  return { valid: errors.length === 0, errors };
}

function flattenAllStructuredTools(turns: KiroTurn[], repairs: ConversationRepairs): void {
  for (const turn of turns) {
    const assistant = turn.assistantResponseMessage;
    if (assistant?.toolUses?.length) {
      for (const call of assistant.toolUses) appendText(assistant, toolCallText(call));
      repairs.invalidToolUses += assistant.toolUses.length;
      delete assistant.toolUses;
    }
    const user = turn.userInputMessage;
    const results = user?.userInputMessageContext?.toolResults;
    if (user && results?.length) {
      flattenResults(user, results);
      repairs.orphanResults += results.length;
      delete user.userInputMessageContext!.toolResults;
      cleanUserContext(user);
    }
  }
}

export interface CanonicalConversation {
  history: KiroTurn[];
  currentMessage: KiroUserTurn;
  repairs: ConversationRepairs;
  valid: boolean;
  errors: string[];
}

/**
 * A strict Kiro conversation: alternating turns, a user turn last, adjacent one-to-one tool
 * pairs, and tool specs only on the current message. One second chance — flatten every
 * structured tool exchange to text — before giving up.
 */
export function canonicalizeConversation(input: {
  history: KiroTurn[];
  currentMessage: KiroUserTurn | null;
  modelId: string;
  toolSpecs?: KiroToolSpec[];
  nameMap?: Map<string, string>;
}): CanonicalConversation {
  const toolSpecs = input.toolSpecs ?? [];
  const nameMap = input.nameMap ?? new Map<string, string>();
  const turns = normalizeTurns(input.history, input.currentMessage, input.modelId);
  const repairs: ConversationRepairs = { missingResults: 0, orphanResults: 0, invalidToolUses: 0 };
  const specNames = new Set(toolSpecs.map((spec) => spec.toolSpecification.name));
  const usedIds = new Set<string>();

  for (let index = 0; index < turns.length; index += 2) {
    const user = turns[index]!.userInputMessage!;
    if (index === 0) {
      const leading = user.userInputMessageContext?.toolResults ?? [];
      if (leading.length > 0) {
        flattenResults(user, leading.map(normalizeToolResult));
        repairs.orphanResults += leading.length;
        delete user.userInputMessageContext!.toolResults;
        cleanUserContext(user);
      }
    }
    const assistant = turns[index + 1]?.assistantResponseMessage;
    const nextUser = turns[index + 2]?.userInputMessage;
    if (assistant && nextUser) reconcileToolPair(assistant, nextUser, index + 1, nameMap, specNames, usedIds, repairs);
  }

  const current = turns[turns.length - 1] as KiroUserTurn;
  current.userInputMessage.userInputMessageContext ??= {};
  if (toolSpecs.length > 0) current.userInputMessage.userInputMessageContext.tools = clone(toolSpecs);
  cleanUserContext(current.userInputMessage);

  let history = turns.slice(0, -1);
  let validation = validateConversation(history, current, toolSpecs);
  if (!validation.valid) {
    flattenAllStructuredTools(turns, repairs);
    history = turns.slice(0, -1);
    validation = validateConversation(history, current, toolSpecs);
  }
  return { history, currentMessage: current, repairs, valid: validation.valid, errors: validation.errors };
}
