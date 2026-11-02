/**
 * Chat Completions ↔ the Responses API, which is the only dialect Codex speaks.
 *
 * `chatgpt.com/backend-api/codex/responses` takes an `input` array and answers with Responses SSE.
 * Every client that reaches this gateway speaks Chat Completions or Anthropic Messages, so without
 * this file the two never meet — and they fail *quietly*: a Chat Completions body has no `input`, so
 * `transformCodexRequest` fills one in with its `"..."` placeholder and the allowlist drops
 * `messages` on the way past. The model answers a prompt the caller never sent.
 *
 * ## The shape of the translation
 *
 * Requests flatten. Chat Completions keeps one message per turn and hangs tool calls off the
 * assistant message; Responses puts every one of those on the same level:
 *
 *     assistant { content, tool_calls: [a, b] }   →   message(assistant), function_call(a),
 *                                                     function_call(b)
 *     tool      { tool_call_id, content }         →   function_call_output(call_id)
 *
 * Responses back to Chat Completions is the reverse, done incrementally: `output_index` says which
 * item a delta belongs to, and tool calls are numbered densely because that is the index a Chat
 * Completions client accumulates into.
 *
 * ## The Anthropic side gets here by composition
 *
 * `mapAnthropicToOpenAI` and `createOpenAIToAnthropicStreamTransformer` already exist in
 * `core/mappers`, so an Anthropic client is translated to Chat Completions first and back last. That
 * keeps one Responses translation rather than a second one that would drift from this.
 */

import { ProviderResponseError, UnsupportedContentPartError } from '@/core/upstream-errors';
import { failureOf, streamFailureAnswer, type StreamFailure } from '../upstream/stream';

/** Chat Completions tool shape, kept as-is: `normalizeCodexTools` flattens it downstream. */
type Json = Record<string, any>;

const encoder = new TextEncoder();

function sseData(payload: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
}

/** Text out of a Chat Completions `content`, which is either a string or an array of parts. */
function contentToText(content: any): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part: any) => (typeof part === 'string' ? part : part?.type === 'text' ? part.text ?? '' : ''))
    .join('');
}

/**
 * The parts of a user message, in Responses' input vocabulary.
 *
 * An image arrives as `image_url` and leaves as `input_image`; anything unrecognised is dropped
 * rather than forwarded, because an unknown part type is a 400 from the Responses API and the error
 * names the index rather than the kind.
 *
 * Audio is the exception: it is refused here, by name. The upstream still never sees the part —
 * that reason for dropping holds — but dropping it would have the model answer a voice note it never
 * heard, and the caller could not tell. Refusing lets it fall back.
 */
function toInputContent(content: any): Json[] {
  if (typeof content === 'string') {
    return [{ type: 'input_text', text: content }];
  }
  if (!Array.isArray(content)) return [];

  const parts: Json[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push({ type: 'input_text', text: part });
      continue;
    }
    if (part?.type === 'text' && typeof part.text === 'string') {
      parts.push({ type: 'input_text', text: part.text });
      continue;
    }
    if (part?.type === 'input_audio') {
      throw new UnsupportedContentPartError('input_audio', 'codex');
    }
    if (part?.type === 'image_url') {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
      if (typeof url === 'string' && url) parts.push({ type: 'input_image', image_url: url });
    }
  }
  return parts;
}

/** `function_call.arguments` and `function_call_output.output` are strings, never objects. */
function toArgumentString(value: any): string {
  if (typeof value === 'string') return value.trim() === '' ? '{}' : value;
  if (value === undefined || value === null) return '{}';
  try {
    return JSON.stringify(value);
  } catch {
    return '{}';
  }
}

function toOutputString(value: any): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return contentToText(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * A Chat Completions body, as a Responses request.
 *
 * `instructions` is deliberately left alone: Codex supplies its own system prompt downstream, and a
 * client's system message goes into `input` as a `developer` message instead — that keeps it inside
 * the cacheable prefix, which is where `transformCodexRequest` expects to find it.
 */
export function mapOpenAIToResponses(openaiBody: any, upstreamModelId: string): Json {
  const messages: any[] = Array.isArray(openaiBody?.messages) ? openaiBody.messages : [];
  const input: Json[] = [];

  for (const message of messages) {
    const role = message?.role;

    if (role === 'system' || role === 'developer') {
      const text = contentToText(message.content);
      if (text) input.push({ type: 'message', role: 'developer', content: [{ type: 'input_text', text }] });
      continue;
    }

    if (role === 'user') {
      const content = toInputContent(message.content);
      if (content.length > 0) input.push({ type: 'message', role: 'user', content });
      continue;
    }

    if (role === 'assistant') {
      const text = contentToText(message.content);
      if (text) {
        input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
      }
      // Flattened onto the same level as the message they came with — see the note above.
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        const callId = call?.id;
        const name = call?.function?.name ?? call?.name;
        if (!callId || !name) continue;
        input.push({
          type: 'function_call',
          call_id: callId,
          name,
          arguments: toArgumentString(call?.function?.arguments ?? call?.arguments),
        });
      }
      continue;
    }

    if (role === 'tool' || role === 'function') {
      const callId = message?.tool_call_id ?? message?.name;
      if (!callId) continue;
      input.push({
        type: 'function_call_output',
        call_id: callId,
        output: toOutputString(message.content),
      });
    }
  }

  const body: Json = { model: upstreamModelId, input };

  if (Array.isArray(openaiBody?.tools) && openaiBody.tools.length > 0) {
    body.tools = openaiBody.tools;
  }

  // Responses names the forced tool at the top level; Chat Completions nests it under `function`.
  const choice = openaiBody?.tool_choice;
  if (typeof choice === 'string') {
    body.tool_choice = choice;
  } else if (choice?.type === 'function') {
    const name = choice.function?.name ?? choice.name;
    if (name) body.tool_choice = { type: 'function', name };
  }

  // Carried through for `transformCodexRequest`, which turns it into `reasoning.effort`.
  if (openaiBody?.reasoning_effort) body.reasoning_effort = openaiBody.reasoning_effort;
  if (openaiBody?.reasoning) body.reasoning = openaiBody.reasoning;

  return body;
}

/** One Chat Completions chunk, with the fields every client expects present. */
function chunk(id: string, model: string, created: number, delta: Json, finishReason: string | null, usage?: Json): Json {
  const payload: Json = {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  if (usage) payload.usage = usage;
  return payload;
}

/** Responses reports token counts under different names than Chat Completions does. */
function toOpenAIUsage(usage: any): Json | undefined {
  if (!usage) return undefined;
  const prompt = Number(usage.input_tokens) || 0;
  const completion = Number(usage.output_tokens) || 0;
  const cached = Number(usage.input_tokens_details?.cached_tokens) || 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: Number(usage.total_tokens) || prompt + completion,
    ...(cached > 0 ? { prompt_tokens_details: { cached_tokens: cached } } : {}),
  };
}

/**
 * What one Responses event does to a Chat Completions stream.
 *
 * Split out from the transformer so the non-streaming path can replay the same interpretation
 * instead of parsing the events a second way — two readings of one protocol is how a tool call
 * shows up when streaming and vanishes when not.
 */
interface ResponsesState {
  /** Dense tool-call index, which is what a Chat Completions client accumulates into. */
  toolIndexByOutput: Map<number, number>;
  /** The same index by the item's id, the key a closing event may carry instead. */
  toolIndexByItem: Map<string, number>;
  /** Calls whose arguments have reached the client, streamed or whole: a closing event never sends them twice. */
  argumentsSent: Set<number>;
  nextToolIndex: number;
  sawToolCall: boolean;
  usage?: Json;
  /** What `response.failed` or an `error` event named — said to the client as an error, never as a finished reply. */
  failure?: StreamFailure;
  /** Why `response.incomplete` ended the answer early: `max_output_tokens`, `content_filter`. */
  incomplete?: string;
}

function newState(): ResponsesState {
  return { toolIndexByOutput: new Map(), toolIndexByItem: new Map(), argumentsSent: new Set(), nextToolIndex: 0, sawToolCall: false };
}

/** The tool-call index an event belongs to, by its output index or its item's id; undefined for a call not yet opened. */
function toolIndexOf(event: any, state: ResponsesState): number | undefined {
  const byOutput = typeof event?.output_index === 'number' ? state.toolIndexByOutput.get(event.output_index) : undefined;
  if (byOutput !== undefined) return byOutput;
  const id = event?.item_id ?? event?.item?.id;
  return typeof id === 'string' ? state.toolIndexByItem.get(id) : undefined;
}

/** A function call opened: its index, id and name, and its arguments where the item already holds them. */
function openCall(item: any, outputIndex: unknown, state: ResponsesState): Json[] {
  const index = state.nextToolIndex++;
  if (typeof outputIndex === 'number') state.toolIndexByOutput.set(outputIndex, index);
  if (typeof item.id === 'string') state.toolIndexByItem.set(item.id, index);
  state.sawToolCall = true;
  const args = typeof item.arguments === 'string' ? item.arguments : '';
  if (args) state.argumentsSent.add(index);
  return [{
    tool_calls: [{
      index,
      id: item.call_id ?? item.id ?? `call_${index}`,
      type: 'function',
      function: { name: item.name ?? '', arguments: args },
    }],
  }];
}

/**
 * A call's whole arguments at its close, sent where none were streamed.
 *
 * Codex streams no argument deltas for calls it makes in parallel: the arguments arrive only when each call closes.
 * Read from the deltas alone, every one of them reached the client as `{}`, and a Nouride agent's three `glob` calls
 * in one step each failed for want of a pattern (found live, 2026-11-02).
 */
function closingArguments(index: number, args: unknown, state: ResponsesState): Json[] {
  if (state.argumentsSent.has(index) || typeof args !== 'string' || !args) return [];
  state.argumentsSent.add(index);
  return [{ tool_calls: [{ index, function: { arguments: args } }] }];
}

/** The deltas one Responses event produces. Empty when the event carries nothing a client needs. */
function eventToDeltas(event: any, state: ResponsesState): Json[] {
  switch (event?.type) {
    case 'response.output_text.delta':
      return typeof event.delta === 'string' && event.delta ? [{ content: event.delta }] : [];

    // Reasoning summaries ride in `reasoning_content`, the field the Anthropic transformer already
    // reads and wraps in <thinking> tags.
    case 'response.reasoning_summary_text.delta':
    case 'response.reasoning_text.delta':
      return typeof event.delta === 'string' && event.delta ? [{ reasoning_content: event.delta }] : [];

    case 'response.output_item.added': {
      const item = event.item;
      if (item?.type !== 'function_call') return [];
      return openCall(item, event.output_index, state);
    }

    case 'response.function_call_arguments.delta': {
      if (typeof event.delta !== 'string' || !event.delta) return [];
      const index = toolIndexOf(event, state) ?? 0;
      state.argumentsSent.add(index);
      return [{ tool_calls: [{ index, function: { arguments: event.delta } }] }];
    }

    case 'response.function_call_arguments.done': {
      const index = toolIndexOf(event, state);
      return index === undefined ? [] : closingArguments(index, event.arguments, state);
    }

    // A call's close carries it whole: its arguments where none were streamed, and the call itself where it was never
    // opened.
    case 'response.output_item.done': {
      const item = event.item;
      if (item?.type !== 'function_call') return [];
      const index = toolIndexOf(event, state);
      return index === undefined ? openCall(item, event.output_index, state) : closingArguments(index, item.arguments, state);
    }

    case 'response.completed':
      state.usage = toOpenAIUsage(event.response?.usage) ?? state.usage;
      return [];

    // Ended before it was done: cut at the output limit or filtered. Its usage is real and is passed on; read as a
    // finish, a reply cut at the limit went out as whole.
    case 'response.incomplete':
      state.usage = toOpenAIUsage(event.response?.usage) ?? state.usage;
      state.incomplete = event.response?.incomplete_details?.reason ?? 'unknown';
      return [];

    case 'response.failed':
    case 'error':
      state.failure = failureOf(event) ?? { message: 'the upstream stream failed' };
      return [];

    default:
      return [];
  }
}

/** Terminal Responses events, after which nothing more is coming. */
function isTerminal(event: any): boolean {
  return event?.type === 'response.completed' || event?.type === 'response.incomplete' || event?.type === 'response.failed' || event?.type === 'error';
}

/** The Chat Completions finish reason for how the answer ended. */
function finishReasonOf(state: ResponsesState): string {
  if (state.incomplete === 'max_output_tokens') return 'length';
  if (state.incomplete === 'content_filter') return 'content_filter';
  return state.sawToolCall ? 'tool_calls' : 'stop';
}

/**
 * A failure after the answer began, as Chat Completions streams one: an `error` object in place of a finish — what the
 * OpenAI SDKs raise on, and what Nouride reads. The 200 has gone out by then; the executor answers one that came before
 * any output with a status instead (`peekSseTransientError`).
 */
function failureChunk(failure: StreamFailure): Json {
  const answer = streamFailureAnswer(failure.code);
  return { error: { message: failure.message, type: answer.type, code: failure.code ?? answer.clientCode } };
}

/**
 * Walk the `data:` lines of an SSE buffer, handing each parsed event to `visit`.
 *
 * Returns whatever is left after the last complete line, which the streaming caller keeps until the
 * next chunk arrives. `event:` lines are ignored: every Responses payload names its own `type`, so
 * the SSE event name carries nothing the JSON does not already say.
 */
function drainEvents(buffer: string, visit: (event: any) => void): string {
  const lines = buffer.split('\n');
  const remainder = lines.pop() ?? '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try {
      visit(JSON.parse(data));
    } catch {
      // A `data:` line that is not JSON is not something a Chat Completions client can be told
      // about; dropping it beats emitting a chunk whose delta is a parse error.
    }
  }

  return remainder;
}

/**
 * Responses SSE in, Chat Completions SSE out.
 *
 * The opening `{ role: 'assistant' }` chunk is emitted eagerly rather than on the first content:
 * clients use it to open the message, and one that never arrives leaves an SDK waiting for a role it
 * has already been given content for.
 */
export function createResponsesToOpenAIStreamTransformer(
  requestedModelId: string,
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const id = `chatcmpl-${Date.now().toString(36)}`;
  const created = Math.floor(Date.now() / 1000);
  const state = newState();

  let buffer = '';
  let closed = false;

  const close = (controller: TransformStreamDefaultController<Uint8Array>) => {
    if (closed) return;
    closed = true;

    if (state.failure) {
      console.warn(`[codex] ${requestedModelId} failed part-way through its answer: ${state.failure.code ?? 'no code'} — ${state.failure.message.slice(0, 200)}`);
      controller.enqueue(sseData(failureChunk(state.failure)));
    } else {
      controller.enqueue(sseData(chunk(id, requestedModelId, created, {}, finishReasonOf(state), state.usage)));
    }
    controller.enqueue(encoder.encode('data: [DONE]\n\n'));
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      controller.enqueue(sseData(chunk(id, requestedModelId, created, { role: 'assistant' }, null)));
    },

    transform(bytes, controller) {
      buffer += decoder.decode(bytes, { stream: true });
      buffer = drainEvents(buffer, (event) => {
        for (const delta of eventToDeltas(event, state)) {
          controller.enqueue(sseData(chunk(id, requestedModelId, created, delta, null)));
        }
        if (isTerminal(event)) close(controller);
      });
    },

    flush(controller) {
      buffer += decoder.decode();
      drainEvents(buffer + '\n', (event) => {
        for (const delta of eventToDeltas(event, state)) {
          controller.enqueue(sseData(chunk(id, requestedModelId, created, delta, null)));
        }
      });
      // A stream that ends without `response.completed` still has to be closed, or the client waits
      // for a terminator that is never coming.
      close(controller);
    },
  });
}

/**
 * The whole Responses stream, as one Chat Completions object.
 *
 * Codex has no non-streaming mode — `transformCodexRequest` sets `stream: true` unconditionally
 * because the upstream rejects anything else — so a client that did not ask for a stream is served
 * by consuming one here.
 */
export async function finalizeResponsesToOpenAIResponse(
  response: Response,
  requestedModelId: string,
): Promise<Response> {
  const text = await response.text();
  const state = newState();

  let content = '';
  let reasoning = '';
  const toolCalls: Json[] = [];

  drainEvents(text + '\n', (event) => {
    for (const delta of eventToDeltas(event, state)) {
      if (typeof delta.content === 'string') content += delta.content;
      if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;

      for (const call of delta.tool_calls ?? []) {
        const existing = toolCalls[call.index];
        if (!existing) {
          toolCalls[call.index] = {
            id: call.id,
            type: 'function',
            function: { name: call.function?.name ?? '', arguments: call.function?.arguments ?? '' },
          };
          continue;
        }
        if (call.function?.name) existing.function.name = call.function.name;
        if (call.function?.arguments) existing.function.arguments += call.function.arguments;
      }
    }
  });

  // Nothing has gone to the client yet: the failure is answered with its status, as one before any output is.
  if (state.failure) {
    const answer = streamFailureAnswer(state.failure.code);
    throw new ProviderResponseError(state.failure.message, { status: answer.status, clientCode: answer.clientCode });
  }

  const message: Json = { role: 'assistant', content: content || null };
  if (reasoning) message.reasoning_content = reasoning;
  const calls = toolCalls.filter(Boolean);
  if (calls.length > 0) message.tool_calls = calls;

  const payload: Json = {
    id: `chatcmpl-${Date.now().toString(36)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: requestedModelId,
    choices: [{ index: 0, message, finish_reason: finishReasonOf({ ...state, sawToolCall: calls.length > 0 }) }],
    ...(state.usage ? { usage: state.usage } : {}),
  };

  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
