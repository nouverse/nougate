/**
 * OpenAI Chat Completions ⇄ Kiro, directly.
 *
 * Request: OpenAI messages become Kiro turns. System and tool messages are user-role on Kiro;
 * system text is wrapped in `<instructions>` because Claude models treat that as authoritative
 * rather than as something the user said.
 *
 * Response: protocol-neutral Kiro events become `chat.completion.chunk` SSE, or one
 * `chat.completion` object for a non-streaming caller. Reasoning goes out as `reasoning_content`.
 */

import { randomUUID } from 'node:crypto';
import { UnsupportedContentPartError } from '@/core/upstream-errors';
import type { KiroTurn, KiroUserInputMessage, KiroUserTurn } from '../session-replay';
import { emptyUserContent } from './conversation';
import type { KiroConversation } from './payload';
import type { KiroEvent, KiroFinishReason, KiroUsage } from './stream-events';

// ─── Request ───────────────────────────────────────────────────────────────

type Images = NonNullable<KiroUserInputMessage['images']>;
type ToolResults = NonNullable<NonNullable<KiroUserInputMessage['userInputMessageContext']>['toolResults']>;

function parseDataUri(url: string): { mimeType: string; base64: string } | null {
  const match = url.match(/^data:([^;,]+);base64,(.*)$/s);
  return match ? { mimeType: match[1]!, base64: match[2]! } : null;
}

function safeJsonParse(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part: any) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n');
}

/**
 * Collapse OpenAI messages into alternating Kiro turns and split off the last user turn as current.
 *
 * Images: Kiro takes base64 only, so a data URI becomes an image and a remote URL becomes a text
 * reference the model can at least see. Audio has no Kiro field and is refused, not dropped.
 */
export function convertOpenAIMessages(messages: any[], model: string, options: { images: boolean }): KiroConversation {
  const history: KiroTurn[] = [];
  let pendingUser: string[] = [];
  let pendingAssistant: string[] = [];
  let pendingResults: ToolResults = [];
  let pendingImages: Images = [];
  let currentRole: 'user' | 'assistant' | null = null;

  const flush = () => {
    if (currentRole === 'user') {
      const user: KiroUserInputMessage = {
        content: pendingUser.join('\n\n').trim() || emptyUserContent(pendingResults.length > 0),
        modelId: model,
      };
      if (pendingImages.length > 0) user.images = pendingImages;
      if (pendingResults.length > 0) user.userInputMessageContext = { toolResults: pendingResults };
      history.push({ userInputMessage: user });
      pendingUser = [];
      pendingResults = [];
      pendingImages = [];
    } else if (currentRole === 'assistant') {
      history.push({ assistantResponseMessage: { content: pendingAssistant.join('\n\n').trim() || '...' } });
      pendingAssistant = [];
    }
  };

  const addImage = (mimeType: string, base64: string) => {
    if (!options.images) throw new UnsupportedContentPartError('image_url', 'kiro');
    pendingImages.push({ format: mimeType.split('/')[1] || mimeType, source: { bytes: base64 } });
  };

  for (const message of Array.isArray(messages) ? messages : []) {
    const role: 'user' | 'assistant' = message?.role === 'assistant' ? 'assistant' : 'user';
    if (role !== currentRole && currentRole !== null) flush();
    currentRole = role;

    if (role === 'user') {
      if (message.role === 'tool') {
        pendingResults.push({
          toolUseId: message.tool_call_id,
          status: message.is_error || message.status === 'error' ? 'error' : 'success',
          content: [{ text: textOf(message.content) }],
        });
        continue;
      }

      const parts: string[] = [];
      if (typeof message.content === 'string') {
        parts.push(message.content);
      } else if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part?.type === 'input_audio') throw new UnsupportedContentPartError('input_audio', 'kiro');
          if (part?.type === 'tool_result') {
            pendingResults.push({
              toolUseId: part.tool_use_id,
              status: part.is_error ? 'error' : 'success',
              content: [{ text: textOf(part.content) }],
            });
          } else if (part?.type === 'text' || typeof part?.text === 'string') {
            parts.push(part.text || '');
          } else if (part?.type === 'image_url') {
            const url = String(part.image_url?.url ?? '');
            const parsed = parseDataUri(url);
            if (parsed) addImage(parsed.mimeType, parsed.base64);
            else if (/^https?:\/\//.test(url)) parts.push(`[Image: ${url}]`);
          } else if (part?.type === 'image' && part.source?.type === 'base64' && part.source.data) {
            addImage(part.source.media_type || 'image/png', part.source.data);
          }
        }
      }
      const content = parts.join('\n');
      if (content) pendingUser.push(message.role === 'system' || message.role === 'developer' ? `<instructions>\n${content}\n</instructions>` : content);
      continue;
    }

    // Assistant: text, then any tool calls on the same turn.
    let text = '';
    let toolUses: Array<{ toolUseId: string; name: string; input: unknown }> = [];
    if (typeof message.content === 'string') {
      text = message.content.trim();
    } else if (Array.isArray(message.content)) {
      text = message.content.filter((part: any) => part?.type === 'text').map((part: any) => part.text).join('\n').trim();
      toolUses = message.content
        .filter((part: any) => part?.type === 'tool_use')
        .map((part: any) => ({ toolUseId: part.id || randomUUID(), name: part.name, input: part.input || {} }));
    }
    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      toolUses = message.tool_calls.map((call: any) => ({
        toolUseId: call.id || randomUUID(),
        name: call.function?.name ?? call.name,
        input: call.function ? safeJsonParse(call.function.arguments) : call.input || {},
      }));
    }
    if (text) pendingAssistant.push(text);
    if (toolUses.length > 0) {
      flush();
      const last = history[history.length - 1];
      if (last?.assistantResponseMessage) last.assistantResponseMessage.toolUses = toolUses;
      currentRole = null;
    }
  }
  if (currentRole !== null) flush();

  return splitCurrent(history, model);
}

/**
 * Take the last user turn out as the current message, then merge any user turns left adjacent.
 * Shared with the Anthropic mapper — the rule is Kiro's, not either dialect's.
 */
export function splitCurrent(history: KiroTurn[], model: string): KiroConversation {
  let currentMessage: KiroUserTurn | null = null;
  for (let index = history.length - 1; index >= 0; index--) {
    if (history[index]!.userInputMessage) {
      currentMessage = history.splice(index, 1)[0] as KiroUserTurn;
      break;
    }
  }

  const merged: KiroTurn[] = [];
  for (const turn of history) {
    if (turn.userInputMessage) {
      if (turn.userInputMessage.userInputMessageContext && Object.keys(turn.userInputMessage.userInputMessageContext).length === 0) {
        delete turn.userInputMessage.userInputMessageContext;
      }
      turn.userInputMessage.modelId ||= model;
    }
    const previous = merged[merged.length - 1];
    if (turn.userInputMessage && previous?.userInputMessage) {
      const target = previous.userInputMessage;
      target.content += `\n\n${turn.userInputMessage.content}`;
      if (turn.userInputMessage.images?.length) target.images = [...(target.images ?? []), ...turn.userInputMessage.images];
      const incoming = turn.userInputMessage.userInputMessageContext?.toolResults;
      if (incoming?.length) {
        target.userInputMessageContext ??= {};
        target.userInputMessageContext.toolResults = [...(target.userInputMessageContext.toolResults ?? []), ...incoming];
      }
    } else {
      merged.push(turn);
    }
  }

  return { history: merged, currentMessage: currentMessage ?? { userInputMessage: { content: '', modelId: model } } };
}

// ─── Response ──────────────────────────────────────────────────────────────

export function openAIUsage(usage: KiroUsage | null): Record<string, unknown> | undefined {
  if (!usage || (usage.promptTokens === undefined && usage.completionTokens === undefined)) return undefined;
  const prompt = (usage.promptTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  const completion = usage.completionTokens ?? 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    ...(usage.cacheReadTokens !== undefined ? { prompt_tokens_details: { cached_tokens: usage.cacheReadTokens } } : {}),
    ...(usage.credits !== undefined ? { kiro_credits: usage.credits, kiro_credit_unit: usage.creditUnit } : {}),
  };
}

/** Writes OpenAI `chat.completion.chunk` SSE for a sequence of Kiro events. */
export class OpenAIStreamEncoder {
  private readonly id = `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  private readonly created = Math.floor(Date.now() / 1000);
  private sentRole = false;
  private toolIndex = 0;

  constructor(private readonly model: string) {}

  private chunk(delta: Record<string, unknown>, finishReason: KiroFinishReason | null = null, usage?: Record<string, unknown>): string {
    if (!this.sentRole) {
      delta = { role: 'assistant', ...delta };
      this.sentRole = true;
    }
    return `data: ${JSON.stringify({
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      ...(usage ? { usage } : {}),
    })}\n\n`;
  }

  start(): string {
    return '';
  }

  encode(event: KiroEvent): string {
    switch (event.type) {
      case 'text':
        return this.chunk({ content: event.text });
      case 'reasoning':
        return this.chunk({ reasoning_content: event.text });
      case 'tool_call': {
        const index = this.toolIndex++;
        return (
          this.chunk({ tool_calls: [{ index, id: event.id, type: 'function', function: { name: event.name, arguments: '' } }] }) +
          this.chunk({ tool_calls: [{ index, function: { arguments: event.arguments } }] })
        );
      }
      case 'end':
        return this.chunk({}, event.finishReason, openAIUsage(event.usage)) + 'data: [DONE]\n\n';
      case 'error':
        return `data: ${JSON.stringify({ error: { message: event.message, type: 'upstream_error', code: event.code } })}\n\ndata: [DONE]\n\n`;
    }
  }

  keepalive(): string {
    return ': kiro-upstream\n\n';
  }
}

/** One `chat.completion` object from a complete event sequence. */
export function buildOpenAICompletion(events: KiroEvent[], model: string): Record<string, unknown> {
  let content = '';
  let reasoning = '';
  const toolCalls: any[] = [];
  let finishReason: KiroFinishReason = 'stop';
  let usage: KiroUsage | null = null;
  for (const event of events) {
    if (event.type === 'text') content += event.text;
    else if (event.type === 'reasoning') reasoning += event.text;
    else if (event.type === 'tool_call') {
      toolCalls.push({ id: event.id, type: 'function', function: { name: event.name, arguments: event.arguments } });
    } else if (event.type === 'end') {
      finishReason = event.finishReason;
      usage = event.usage;
    }
  }
  const usageBlock = openAIUsage(usage);
  return {
    id: `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: content || (toolCalls.length > 0 ? null : ''),
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReason,
      },
    ],
    ...(usageBlock ? { usage: usageBlock } : {}),
  };
}
