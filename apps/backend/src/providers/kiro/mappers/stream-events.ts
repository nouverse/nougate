/**
 * Kiro's EventStream, read as a sequence of protocol-neutral events.
 *
 * This is the one place that knows what Kiro's frames mean. Both client dialects consume its output
 * directly — `openai.ts` writes Chat Completions chunks, `anthropic.ts` writes Messages events — so
 * neither response goes through the other's shape on its way out.
 *
 * ## What streams, and what waits
 *
 * Text and reasoning are emitted the moment their frame decodes. A tool call is the one thing that
 * must be whole before it is useful — a client cannot run half an argument object — so each is
 * held until Kiro marks it finished (or the turn ends), validated, and then emitted in one piece.
 * That buffer is per tool and bounded; nothing else is held.
 *
 * ## Reasoning is kept, not stripped
 *
 * Models on the legacy `<thinking_mode>` path write their reasoning inline as
 * `<thinking>…</thinking>`. Those spans are lifted out into `reasoning` events — a tag split across
 * two frames included — so a client sees a reasoning block instead of either losing the reasoning or
 * seeing raw tags in the answer. Native `reasoningContentEvent` frames map to the same event.
 */

import { EventStreamDecoder, EventStreamError, type EventStreamFrame } from '../wire/event-stream';

export interface KiroUsage {
  promptTokens?: number;
  completionTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Kiro credits charged for the turn, as metered upstream. */
  credits?: number;
  creditUnit?: string;
}

export type KiroFinishReason = 'stop' | 'tool_calls' | 'length';

export type KiroEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; id: string; name: string; arguments: string }
  | { type: 'end'; finishReason: KiroFinishReason; usage: KiroUsage | null }
  /** Terminal. `status` is what the failure would be as an HTTP answer, for classification. */
  | { type: 'error'; code: string; message: string; status: number };

export interface KiroInterpreterOptions {
  /** Split `<thinking>` spans out of assistant text. On when the legacy prompt tag was sent. */
  inlineThinking: boolean;
  /** Sanitised tool name → the name the client declared. */
  toolNameMap?: Map<string, string>;
  /** Declared input window, used to turn Kiro's context-usage percentage into a token count. */
  contextWindow?: number;
  /** Ceiling on tool input held while it is still arriving. */
  maxToolInputBytes: number;
}

// ─── Stop reasons ──────────────────────────────────────────────────────────

type StopDisposition =
  | 'complete'
  | 'tool_use'
  | 'length'
  | 'retryable_protocol_failure'
  | 'terminal_incomplete'
  | 'terminal_refusal'
  | 'unknown_failure';

export function normalizeStopReason(value: unknown): string | null {
  const reason = String(value ?? '')
    .trim()
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (['endturn', 'end_turn', 'stop', 'stop_sequence'].includes(reason)) return 'end_turn';
  if (['tooluse', 'tool_use', 'tool_calls'].includes(reason)) return 'tool_use';
  if (['maxtokens', 'max_tokens', 'max_output_tokens', 'length'].includes(reason)) return 'max_tokens';
  return reason || null;
}

/** Stop reasons that mean "usable as far as it got" — what finish reason `length` is for. */
const TRUNCATION_STOP_REASONS = new Set(['model_context_window_exceeded', 'max_tokens']);

export function stopDisposition(stopReason: string | null, hasToolCalls: boolean): StopDisposition {
  if (stopReason === 'malformed_model_output' || stopReason === 'invalid_model_output') return 'retryable_protocol_failure';
  if (stopReason === 'cancelled' || stopReason === 'pause_turn' || stopReason === 'model_context_window_exceeded') {
    return 'terminal_incomplete';
  }
  if (stopReason === 'refusal' || /(?:content.*filter|guardrail|safety|policy|blocked)/u.test(stopReason ?? '')) {
    return 'terminal_refusal';
  }
  if (stopReason === 'max_tokens') return hasToolCalls ? 'terminal_incomplete' : 'length';
  if (stopReason && stopReason !== 'end_turn' && stopReason !== 'tool_use') return 'unknown_failure';
  if (hasToolCalls || stopReason === 'tool_use') return 'tool_use';
  return 'complete';
}

const SEVERITY: Record<StopDisposition, number> = {
  terminal_refusal: 6,
  terminal_incomplete: 5,
  unknown_failure: 4,
  retryable_protocol_failure: 3,
  length: 2,
  complete: 1,
  tool_use: 1,
};

/** Two frames may each carry a stop reason; the more severe one is the truth about the turn. */
export function mergeStopReason(current: string | null, incoming: string | null): string | null {
  if (!incoming) return current;
  if (!current) return incoming;
  return SEVERITY[stopDisposition(incoming, false)] > SEVERITY[stopDisposition(current, false)] ? incoming : current;
}

/** An AWS exception name as the HTTP status it would have been, so the executor can classify it. */
export function exceptionStatus(exceptionType: string): number {
  const type = exceptionType.toLowerCase();
  if (type.includes('throttl') || type.includes('quota') || type.includes('toomanyrequests')) return 429;
  if (type.includes('accessdenied') || type.includes('unauthorized') || type.includes('expiredtoken')) return 403;
  if (type.includes('validation') || type.includes('badrequest')) return 400;
  if (type.includes('serviceunavailable') || type.includes('overload')) return 503;
  if (type.includes('internal')) return 500;
  return 502;
}

// ─── Inline <thinking> splitting ───────────────────────────────────────────

const OPEN_TAG = '<thinking>';
const CLOSE_TAG = '</thinking>';

/**
 * Separates `<thinking>` spans from answer text across arbitrarily split input. A suffix that could
 * still become a tag is held back until the next piece decides it — at most nine characters.
 */
export class ThinkingSplitter {
  private buffer = '';
  private inThinking = false;
  private trimLeadingNewline = false;

  push(chunk: string): Array<{ kind: 'text' | 'reasoning'; text: string }> {
    this.buffer += chunk;
    const out: Array<{ kind: 'text' | 'reasoning'; text: string }> = [];

    while (true) {
      const tag = this.inThinking ? CLOSE_TAG : OPEN_TAG;
      const index = this.buffer.indexOf(tag);
      if (index >= 0) {
        this.emit(out, this.buffer.slice(0, index));
        this.buffer = this.buffer.slice(index + tag.length);
        this.inThinking = !this.inThinking;
        // The model puts a newline after each tag; it belongs to the tag, not the content.
        this.trimLeadingNewline = true;
        continue;
      }
      const keep = partialTagSuffix(this.buffer, tag);
      this.emit(out, this.buffer.slice(0, this.buffer.length - keep));
      this.buffer = this.buffer.slice(this.buffer.length - keep);
      return out;
    }
  }

  /** Whatever is held back, released as what it was going to be. */
  flush(): Array<{ kind: 'text' | 'reasoning'; text: string }> {
    const out: Array<{ kind: 'text' | 'reasoning'; text: string }> = [];
    this.emit(out, this.buffer);
    this.buffer = '';
    return out;
  }

  private emit(out: Array<{ kind: 'text' | 'reasoning'; text: string }>, text: string): void {
    if (this.trimLeadingNewline && text) {
      text = text.replace(/^\n/u, '');
      this.trimLeadingNewline = false;
    }
    if (!text) return;
    const kind = this.inThinking ? 'reasoning' : 'text';
    const last = out[out.length - 1];
    if (last?.kind === kind) last.text += text;
    else out.push({ kind, text });
  }
}

/** Length of the longest suffix of `text` that is a proper prefix of `tag`. */
function partialTagSuffix(text: string, tag: string): number {
  for (let length = Math.min(tag.length - 1, text.length); length > 0; length--) {
    if (text.endsWith(tag.slice(0, length))) return length;
  }
  return 0;
}

// ─── The interpreter ───────────────────────────────────────────────────────

interface PendingTool {
  id: string;
  name: string;
  kind?: 'string' | 'object';
  chunks: string[];
  object?: Record<string, unknown>;
  bytes: number;
}

class ToolBufferExceeded extends Error {}

const textEncoder = new TextEncoder();

/**
 * Feed it raw upstream bytes; take out events. `end()` at clean EOF produces the terminal event.
 * After an `error` or `end` event, further input is ignored.
 */
export class KiroStreamInterpreter {
  private readonly decoder = new EventStreamDecoder();
  private readonly splitter: ThinkingSplitter | null;
  private readonly tools = new Map<string, PendingTool>();
  private readonly created = Math.floor(Date.now() / 1000);
  private bufferedToolBytes = 0;

  private emittedOutput = false;
  private emittedToolCalls = false;
  private sawToolUse = false;
  private explicitStop = false;
  private stopReason: string | null = null;
  private toolValidationError: string | null = null;
  private contextUsagePercentage: number | null = null;
  private usage: KiroUsage | null = null;
  private finished = false;

  /** Frames decoded so far, including ones that produced no client-visible event. */
  framesDecoded = 0;

  constructor(private readonly options: KiroInterpreterOptions) {
    this.splitter = options.inlineThinking ? new ThinkingSplitter() : null;
  }

  get isFinished(): boolean {
    return this.finished;
  }

  pushBytes(chunk: Uint8Array): KiroEvent[] {
    if (this.finished) return [];
    let frames: EventStreamFrame[];
    try {
      frames = this.decoder.push(chunk);
    } catch (error) {
      return [this.fail('kiro_corrupt_eventstream', (error as Error).message, 502)];
    }
    const events: KiroEvent[] = [];
    for (const frame of frames) {
      this.framesDecoded++;
      events.push(...this.processFrame(frame));
      if (this.finished) break;
    }
    return events;
  }

  /** Clean EOF from upstream. */
  end(): KiroEvent[] {
    if (this.finished) return [];
    if (this.decoder.bufferedBytes > 0) {
      return [this.fail('kiro_missing_terminal', 'Kiro EventStream ended with a truncated frame', 502)];
    }

    const events: KiroEvent[] = [];
    if (this.splitter) events.push(...this.splitterEvents(this.splitter.flush()));

    try {
      events.push(...this.flushTools());
    } catch (error) {
      if (error instanceof ToolBufferExceeded) return [...events, this.fail('kiro_tool_input_too_large', error.message, 502)];
      throw error;
    }

    const disposition = stopDisposition(this.stopReason, this.emittedToolCalls || this.sawToolUse);
    const truncated =
      disposition === 'terminal_incomplete' && TRUNCATION_STOP_REASONS.has(this.stopReason ?? '') && this.emittedOutput;

    if (!truncated && disposition !== 'complete' && disposition !== 'tool_use' && disposition !== 'length') {
      const code =
        disposition === 'retryable_protocol_failure'
          ? 'kiro_retryable_protocol_failure'
          : disposition === 'terminal_refusal'
            ? 'kiro_terminal_refusal'
            : disposition === 'terminal_incomplete'
              ? 'kiro_terminal_incomplete'
              : 'kiro_unknown_stop_reason';
      return [...events, this.fail(code, `Kiro ended with non-success stop reason: ${this.stopReason}`, 502)];
    }

    if (this.toolValidationError && !this.emittedOutput) {
      return [...events, this.fail('invalid_kiro_tool_call', this.toolValidationError, 502)];
    }
    if (!this.emittedOutput && !this.explicitStop) {
      return [...events, this.fail('kiro_missing_terminal', 'Kiro EventStream ended without model output', 502)];
    }
    if (this.stopReason === 'tool_use' && !this.emittedOutput) {
      return [...events, this.fail('invalid_kiro_tool_call', 'Kiro declared a tool call but sent none', 502)];
    }

    if (truncated) {
      console.warn(`[kiro] turn truncated (stop_reason=${this.stopReason}); closing as length`);
    }
    const finishReason: KiroFinishReason = truncated || disposition === 'length'
      ? 'length'
      : this.emittedToolCalls
        ? 'tool_calls'
        : 'stop';

    this.finished = true;
    events.push({ type: 'end', finishReason, usage: this.finalUsage() });
    return events;
  }

  /** Abandon the stream with an error, e.g. on a transport failure the caller saw. */
  fail(code: string, message: string, status: number): KiroEvent {
    this.finished = true;
    return { type: 'error', code, message, status };
  }

  private finalUsage(): KiroUsage | null {
    const usage: KiroUsage = { ...(this.usage ?? {}) };
    // Only when the upstream gave no token counts: Kiro's own measure of how full the context is,
    // scaled by the model's declared window. No window, no figure — never a guessed one.
    if (usage.promptTokens === undefined && this.contextUsagePercentage !== null && this.options.contextWindow) {
      usage.promptTokens = Math.round((this.contextUsagePercentage * this.options.contextWindow) / 100);
    }
    return Object.keys(usage).length > 0 ? usage : null;
  }

  private splitterEvents(parts: Array<{ kind: 'text' | 'reasoning'; text: string }>): KiroEvent[] {
    return parts.map((part) => {
      this.emittedOutput = true;
      return part.kind === 'reasoning' ? { type: 'reasoning', text: part.text } : { type: 'text', text: part.text };
    });
  }

  private emitText(text: string): KiroEvent[] {
    if (!text) return [];
    if (this.splitter) return this.splitterEvents(this.splitter.push(text));
    this.emittedOutput = true;
    return [{ type: 'text', text }];
  }

  private processFrame(frame: EventStreamFrame): KiroEvent[] {
    const messageType = frame.headers[':message-type'];
    if (messageType === 'error' || messageType === 'exception') {
      const exceptionType = String(frame.headers[':exception-type'] ?? frame.headers[':error-code'] ?? '');
      const message =
        frame.payload?.message || frame.payload?.Message || `Kiro upstream sent an EventStream ${messageType}`;
      return [this.fail('kiro_upstream_eventstream_error', String(message), exceptionStatus(exceptionType))];
    }

    const eventType = String(frame.headers[':event-type'] ?? '');
    const payload = frame.payload ?? {};

    try {
      switch (eventType) {
        case 'assistantResponseEvent':
          return typeof payload.content === 'string' ? this.emitText(payload.content) : [];

        case 'codeEvent':
          // Code arrives verbatim and is never inside a thinking span.
          if (typeof payload.content !== 'string' || !payload.content) return [];
          this.emittedOutput = true;
          return [{ type: 'text', text: payload.content }];

        case 'reasoningContentEvent': {
          const value = payload.reasoningContentEvent ?? payload;
          const text = typeof value === 'string' ? value : value.text || value.content || '';
          if (!text) return [];
          this.emittedOutput = true;
          return [{ type: 'reasoning', text }];
        }

        case 'toolUseEvent':
          return this.processToolUse(payload);

        case 'messageStopEvent': {
          this.explicitStop = true;
          const reason =
            normalizeStopReason(payload.stopReason ?? payload.stop_reason) ?? (this.sawToolUse ? 'tool_use' : 'end_turn');
          this.stopReason = mergeStopReason(this.stopReason, reason);
          return this.flushTools();
        }

        case 'metadataEvent':
        case 'MetadataEvent': {
          const metadata = payload.metadataEvent ?? payload.metadata ?? payload;
          const reason = normalizeStopReason(metadata?.stopReason ?? metadata?.stop_reason);
          if (reason) {
            this.explicitStop = true;
            this.stopReason = mergeStopReason(this.stopReason, reason);
          }
          this.absorbTokenUsage(metadata?.tokenUsage ?? metadata?.usage);
          return [];
        }

        case 'contextUsageEvent': {
          const percentage = Number(payload.contextUsagePercentage);
          if (Number.isFinite(percentage)) this.contextUsagePercentage = percentage;
          return [];
        }

        case 'meteringEvent': {
          const metering = payload.meteringEvent ?? payload;
          const credits = Number(metering.usage);
          if (Number.isFinite(credits)) {
            this.usage = {
              ...this.usage,
              credits,
              creditUnit: typeof metering.unit === 'string' ? metering.unit : 'credit',
            };
          }
          return [];
        }

        case 'metricsEvent':
          this.absorbTokenUsage(payload.metricsEvent ?? payload);
          return [];

        default:
          return [];
      }
    } catch (error) {
      if (error instanceof ToolBufferExceeded) return [this.fail('kiro_tool_input_too_large', error.message, 502)];
      throw error;
    }
  }

  private absorbTokenUsage(metrics: any): void {
    if (!metrics || typeof metrics !== 'object') return;
    const prompt = Number(metrics.inputTokens ?? metrics.input_tokens);
    const completion = Number(metrics.outputTokens ?? metrics.output_tokens);
    if (!(prompt > 0) && !(completion > 0)) return;
    const cacheRead = Number(metrics.cacheReadInputTokens ?? metrics.cache_read_input_tokens);
    const cacheWrite = Number(metrics.cacheCreationInputTokens ?? metrics.cache_creation_input_tokens);
    this.usage = {
      ...this.usage,
      ...(prompt > 0 ? { promptTokens: prompt } : {}),
      ...(completion > 0 ? { completionTokens: completion } : {}),
      ...(Number.isFinite(cacheRead) && cacheRead >= 0 ? { cacheReadTokens: cacheRead } : {}),
      ...(Number.isFinite(cacheWrite) && cacheWrite >= 0 ? { cacheWriteTokens: cacheWrite } : {}),
    };
  }

  // ─── Tool calls ──────────────────────────────────────────────────────────

  private reserve(bytes: number): void {
    this.bufferedToolBytes += bytes;
    if (this.bufferedToolBytes > this.options.maxToolInputBytes) {
      throw new ToolBufferExceeded(`Kiro tool input exceeded ${this.options.maxToolInputBytes} bytes`);
    }
  }

  private processToolUse(payload: any): KiroEvent[] {
    this.sawToolUse = true;
    const fragments = Array.isArray(payload) ? payload : [payload];
    const events: KiroEvent[] = [];

    for (const fragment of fragments) {
      // One unusable fragment belongs to one tool. Rejecting it must not take the complete calls
      // already buffered with it, so it is recorded and skipped rather than thrown.
      const name = typeof fragment?.name === 'string' ? fragment.name.trim() : '';
      if (!name) {
        this.rejectFragment('Kiro toolUseEvent is missing a tool name');
        continue;
      }
      let id: string;
      if (fragment.toolUseId == null) {
        id = `call_${this.created}_${this.tools.size + 1}`;
      } else if (typeof fragment.toolUseId !== 'string' || !fragment.toolUseId.trim()) {
        this.rejectFragment('Kiro toolUseEvent has an invalid toolUseId');
        continue;
      } else {
        id = fragment.toolUseId;
      }

      let tool = this.tools.get(id);
      if (!tool) {
        tool = { id, name, chunks: [], bytes: 0 };
        this.tools.set(id, tool);
        this.reserve(textEncoder.encode(id).byteLength + textEncoder.encode(name).byteLength + 32);
      } else if (tool.name !== name) {
        this.rejectFragment('Kiro tool name changed between fragments');
        continue;
      }

      if (!this.appendInput(tool, fragment.input)) continue;
      if (fragment.stop === true) {
        // Text the splitter is holding back came before this call; release it first.
        if (this.splitter) events.push(...this.splitterEvents(this.splitter.flush()));
        events.push(...this.finalizeTool(tool));
      }
    }
    return events;
  }

  private appendInput(tool: PendingTool, input: unknown): boolean {
    if (input === undefined || input === null) return true;
    if (typeof input === 'string') {
      if (tool.kind === 'object') return this.rejectFragment('Kiro tool input changed fragment type');
      tool.kind = 'string';
      tool.chunks.push(input);
      const bytes = textEncoder.encode(input).byteLength;
      tool.bytes += bytes;
      this.reserve(bytes);
      return true;
    }
    if (typeof input === 'object' && !Array.isArray(input)) {
      if (tool.kind === 'string') return this.rejectFragment('Kiro tool input changed fragment type');
      tool.kind = 'object';
      const bytes = textEncoder.encode(JSON.stringify(input)).byteLength;
      this.bufferedToolBytes -= tool.bytes;
      tool.object = input as Record<string, unknown>;
      tool.bytes = bytes;
      this.reserve(bytes);
      return true;
    }
    return this.rejectFragment('Kiro tool input must be a JSON object');
  }

  private rejectFragment(message: string): false {
    this.toolValidationError ??= message;
    console.warn(`[kiro] tool fragment rejected: ${message}`);
    return false;
  }

  private parseInput(tool: PendingTool): Record<string, unknown> {
    if (tool.kind === 'object') return tool.object!;
    const joined = tool.chunks.join('').trim();
    if (!joined) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(joined);
    } catch (error) {
      throw new Error(`Kiro tool input is not valid JSON (${(error as Error).message})`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Kiro tool input is not a JSON object');
    return parsed as Record<string, unknown>;
  }

  /** Validate one finished tool and emit it, or drop it with a logged reason. */
  private finalizeTool(tool: PendingTool): KiroEvent[] {
    this.tools.delete(tool.id);
    this.bufferedToolBytes = Math.max(0, this.bufferedToolBytes - tool.bytes);
    let input: Record<string, unknown>;
    try {
      input = this.parseInput(tool);
      // `tool_call` is Kiro's MCP wrapper; without a nested name and arguments it cannot be run.
      if (tool.name === 'tool_call') {
        if (typeof input.name !== 'string' || !input.name.trim()) throw new Error('Kiro tool_call wrapper is missing the MCP tool name');
        if (!Object.hasOwn(input, 'arguments')) throw new Error('Kiro tool_call wrapper is missing the MCP tool arguments');
      }
    } catch (error) {
      this.toolValidationError ??= (error as Error).message;
      console.warn(`[kiro] dropping unusable tool call ${tool.id} (${tool.name}): ${(error as Error).message}`);
      return [];
    }
    this.emittedOutput = true;
    this.emittedToolCalls = true;
    return [
      {
        type: 'tool_call',
        id: tool.id,
        name: this.options.toolNameMap?.get(tool.name) ?? tool.name,
        arguments: JSON.stringify(input),
      },
    ];
  }

  private flushTools(): KiroEvent[] {
    const events: KiroEvent[] = [];
    // Text held by the splitter came before these tools; release it first so order is preserved.
    if (this.splitter && this.tools.size > 0) events.push(...this.splitterEvents(this.splitter.flush()));
    for (const tool of [...this.tools.values()]) events.push(...this.finalizeTool(tool));
    this.bufferedToolBytes = 0;
    return events;
  }

  /** For the executor's first-frame check: nothing the client could see has been produced yet. */
  get hasEmittedOutput(): boolean {
    return this.emittedOutput;
  }
}

export { EventStreamError };
