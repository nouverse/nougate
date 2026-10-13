/**
 * Anthropic Messages ⇄ Kiro, directly — never through the OpenAI shape.
 *
 * The OpenAI round trip is lossy exactly where Anthropic clients care: thinking blocks become
 * `<thinking>` text inside a text block, tool ids are re-minted, `is_error` is dropped, and images
 * inside tool results vanish. Mapping straight across keeps all four.
 *
 * Request: `system` is lifted out as text (it travels in the first user turn, see `payload.ts`);
 * text, base64 images and tool results become user turns; text and tool uses become assistant
 * turns. Images a tool returned — screenshots — ride along as user images, since Kiro tool results
 * are text-only. Thinking blocks in history are not sent back: Kiro has no field for them.
 *
 * Response: Kiro events become `message_start` / `content_block_*` / `message_delta` /
 * `message_stop`, with reasoning in real `thinking` blocks.
 */

import { randomUUID } from 'node:crypto';
import { UnsupportedContentPartError } from '@/core/upstream-errors';
import type { KiroTurn, KiroUserInputMessage } from '../session-replay';
import { emptyUserContent } from './conversation';
import { splitCurrent } from './openai';
import type { KiroConversation } from './payload';
import type { KiroEvent, KiroFinishReason, KiroUsage } from './stream-events';

// ─── Request ───────────────────────────────────────────────────────────────

type Images = NonNullable<KiroUserInputMessage['images']>;
type ToolResults = NonNullable<NonNullable<KiroUserInputMessage['userInputMessageContext']>['toolResults']>;

export function extractSystemText(system: unknown): string {
  if (!system) return '';
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system
      .map((part: any) => (typeof part === 'string' ? part : part?.text || ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function imageFormat(mediaType: string | undefined): string {
  const type = mediaType || 'image/png';
  return type.split('/')[1] || type;
}

export function convertAnthropicMessages(messages: any[], model: string, options: { images: boolean }): KiroConversation {
  const history: KiroTurn[] = [];
  let pendingUser: string[] = [];
  let pendingAssistant: string[] = [];
  let pendingResults: ToolResults = [];
  let pendingImages: Images = [];
  let currentRole: 'user' | 'assistant' | null = null;

  const addImage = (source: any) => {
    if (!options.images) throw new UnsupportedContentPartError('image', 'kiro');
    pendingImages.push({ format: imageFormat(source.media_type), source: { bytes: source.data } });
  };

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

  for (const message of Array.isArray(messages) ? messages : []) {
    const role: 'user' | 'assistant' = message?.role === 'assistant' ? 'assistant' : 'user';
    if (role !== currentRole && currentRole !== null) flush();
    currentRole = role;

    if (role === 'user') {
      if (typeof message.content === 'string') {
        pendingUser.push(message.content);
        continue;
      }
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block?.type === 'text') {
          pendingUser.push(block.text);
        } else if (block?.type === 'image') {
          if (block.source?.type === 'base64') addImage(block.source);
          else if (block.source?.type === 'url' && block.source.url) pendingUser.push(`[Image: ${block.source.url}]`);
        } else if (block?.type === 'document' || block?.type === 'input_audio') {
          throw new UnsupportedContentPartError(block.type, 'kiro');
        } else if (block?.type === 'tool_result') {
          let text = '';
          if (typeof block.content === 'string') {
            text = block.content;
          } else if (Array.isArray(block.content)) {
            let hasImage = false;
            for (const part of block.content) {
              if (part?.type === 'image' && part.source?.type === 'base64') {
                hasImage = true;
                addImage(part.source);
              }
            }
            text =
              block.content.filter((part: any) => part?.type === 'text').map((part: any) => part.text).join('\n') ||
              (hasImage ? '(image attached)' : JSON.stringify(block.content));
          } else if (block.content) {
            text = JSON.stringify(block.content);
          }
          pendingResults.push({
            toolUseId: block.tool_use_id,
            status: block.is_error ? 'error' : 'success',
            content: [{ text }],
          });
        }
      }
      continue;
    }

    let text = '';
    const toolUses: Array<{ toolUseId: string; name: string; input: unknown }> = [];
    if (typeof message.content === 'string') {
      text = message.content;
    } else {
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block?.type === 'text') text += block.text;
        else if (block?.type === 'tool_use') toolUses.push({ toolUseId: block.id, name: block.name, input: block.input || {} });
      }
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

// ─── Response ──────────────────────────────────────────────────────────────

const STOP_REASONS: Record<KiroFinishReason, string> = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
};

/**
 * Kiro reports `inputTokens` excluding cache hits, beside separate cache fields — the Anthropic
 * convention already, so it maps across unchanged. Zero means "not reported"; the metrics tracker
 * estimates in that case rather than recording it.
 */
export function anthropicUsage(usage: KiroUsage | null): Record<string, number> {
  return {
    input_tokens: usage?.promptTokens ?? 0,
    output_tokens: usage?.completionTokens ?? 0,
    ...(usage?.cacheReadTokens !== undefined ? { cache_read_input_tokens: usage.cacheReadTokens } : {}),
    ...(usage?.cacheWriteTokens !== undefined ? { cache_creation_input_tokens: usage.cacheWriteTokens } : {}),
  };
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function newMessageId(): string {
  return `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

/** Writes Anthropic Messages SSE for a sequence of Kiro events. */
export class AnthropicStreamEncoder {
  private nextIndex = 0;
  private open: { index: number; type: 'text' | 'thinking' } | null = null;

  constructor(
    private readonly model: string,
    private readonly messageId: string = newMessageId(),
  ) {}

  start(): string {
    return sse('message_start', {
      type: 'message_start',
      message: {
        id: this.messageId,
        type: 'message',
        role: 'assistant',
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  private closeOpen(): string {
    if (!this.open) return '';
    const out = sse('content_block_stop', { type: 'content_block_stop', index: this.open.index });
    this.open = null;
    return out;
  }

  private ensureBlock(type: 'text' | 'thinking'): string {
    if (this.open?.type === type) return '';
    const out = this.closeOpen();
    const index = this.nextIndex++;
    this.open = { index, type };
    const block = type === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '' };
    return out + sse('content_block_start', { type: 'content_block_start', index, content_block: block });
  }

  encode(event: KiroEvent): string {
    switch (event.type) {
      case 'text': {
        const prefix = this.ensureBlock('text');
        return prefix + sse('content_block_delta', {
          type: 'content_block_delta',
          index: this.open!.index,
          delta: { type: 'text_delta', text: event.text },
        });
      }
      case 'reasoning': {
        const prefix = this.ensureBlock('thinking');
        return prefix + sse('content_block_delta', {
          type: 'content_block_delta',
          index: this.open!.index,
          delta: { type: 'thinking_delta', thinking: event.text },
        });
      }
      case 'tool_call': {
        const index = this.nextIndex++;
        return (
          this.closeOpen() +
          sse('content_block_start', {
            type: 'content_block_start',
            index,
            content_block: { type: 'tool_use', id: event.id, name: event.name, input: {} },
          }) +
          sse('content_block_delta', {
            type: 'content_block_delta',
            index,
            delta: { type: 'input_json_delta', partial_json: event.arguments },
          }) +
          sse('content_block_stop', { type: 'content_block_stop', index })
        );
      }
      case 'end':
        return (
          this.closeOpen() +
          sse('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: STOP_REASONS[event.finishReason], stop_sequence: null },
            usage: anthropicUsage(event.usage),
          }) +
          sse('message_stop', { type: 'message_stop' })
        );
      case 'error':
        return (
          this.closeOpen() +
          sse('error', { type: 'error', error: { type: 'api_error', message: event.message, code: event.code } })
        );
    }
  }

  keepalive(): string {
    return sse('ping', { type: 'ping' });
  }
}

/** One Messages response object from a complete event sequence. */
export function buildAnthropicMessage(events: KiroEvent[], model: string, messageId = newMessageId()): Record<string, unknown> {
  const content: any[] = [];
  let finishReason: KiroFinishReason = 'stop';
  let usage: KiroUsage | null = null;

  for (const event of events) {
    const last = content[content.length - 1];
    if (event.type === 'text') {
      if (last?.type === 'text') last.text += event.text;
      else content.push({ type: 'text', text: event.text });
    } else if (event.type === 'reasoning') {
      if (last?.type === 'thinking') last.thinking += event.text;
      else content.push({ type: 'thinking', thinking: event.text });
    } else if (event.type === 'tool_call') {
      content.push({ type: 'tool_use', id: event.id, name: event.name, input: JSON.parse(event.arguments) });
    } else if (event.type === 'end') {
      finishReason = event.finishReason;
      usage = event.usage;
    }
  }

  return {
    id: messageId,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: STOP_REASONS[finishReason],
    stop_sequence: null,
    usage: anthropicUsage(usage),
  };
}
