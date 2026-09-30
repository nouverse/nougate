/**
 * OpenAI → Anthropic request mapping, plus the reverse mapping for responses.
 *
 * Used when a custom provider's upstream speaks the Anthropic Messages dialect
 * but the client called the OpenAI-compatible route.
 */
import { getCavemanPrompt } from '@/core/caveman';
import { cacheReadTokens, openAiCacheUsage, promptTokens } from "@/core/usage-cache";
import { UnsupportedContentPartError } from '@/core/upstream-errors';

const DEFAULT_MAX_TOKENS = 8192;

/**
 * How much system prompt earns a cache breakpoint.
 *
 * ~4k characters is roughly Anthropic's 1024-token minimum for its larger models, which is the point
 * below which a breakpoint is ignored anyway. Characters rather than a token estimate on purpose: this
 * runs on every request, and a tokenizer here would cost more than the branch is worth.
 */
const CACHE_BREAKPOINT_MIN_CHARS = 4000;

/**
 * Anthropic requires tool results to be user-turn blocks, and consecutive
 * same-role turns are rejected, so adjacent turns are merged as we build them.
 */
function pushMessage(messages: any[], role: 'user' | 'assistant', blocks: any[]): void {
  if (blocks.length === 0) {
    return;
  }

  const last = messages[messages.length - 1];
  if (last && last.role === role) {
    last.content.push(...blocks);
    return;
  }

  messages.push({ role, content: blocks });
}

/**
 * Normalize an OpenAI message `content` value into Anthropic content blocks.
 *
 * `input_audio` is refused, not dropped: the Messages API has no audio block, and a model that is
 * handed the text of a turn without its voice note answers as though it had heard it. Other
 * unrecognised parts are still skipped as before — only audio has a caller waiting to fall back.
 */
function contentToBlocks(content: any, providerId: string): any[] {
  if (content === null || content === undefined) {
    return [];
  }

  if (typeof content === 'string') {
    return content ? [{ type: 'text', text: content }] : [];
  }

  if (!Array.isArray(content)) {
    return [{ type: 'text', text: String(content) }];
  }

  const blocks: any[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      blocks.push({ type: 'text', text: part });
      continue;
    }

    if (part?.type === 'text' && typeof part.text === 'string') {
      blocks.push({ type: 'text', text: part.text });
      continue;
    }

    if (part?.type === 'input_audio') {
      throw new UnsupportedContentPartError('input_audio', providerId);
    }

    if (part?.type === 'image_url' && typeof part.image_url?.url === 'string') {
      const match = part.image_url.url.match(/^data:([^;]+);base64,(.*)$/);
      if (match) {
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: match[1], data: match[2] },
        });
      } else {
        blocks.push({
          type: 'image',
          source: { type: 'url', url: part.image_url.url },
        });
      }
    }
  }

  return blocks;
}

/**
 * Convert an OpenAI chat-completions request into an Anthropic Messages request.
 *
 * `providerId` only names the route in a refusal, so the caller learns which provider could not
 * carry the part rather than a generic "Anthropic".
 */
export function mapOpenAIToAnthropic(
  openaiBody: any,
  upstreamModelId: string,
  fallbackMaxTokens = DEFAULT_MAX_TOKENS,
  providerId = 'anthropic',
): any {
  const systemParts: string[] = [];
  const messages: any[] = [];

  const cavemanPrefix = getCavemanPrompt();
  if (cavemanPrefix) {
    systemParts.push(cavemanPrefix);
  }

  for (const msg of openaiBody.messages ?? []) {
    if (msg.role === 'system' || msg.role === 'developer') {
      const text = typeof msg.content === 'string'
        ? msg.content
        : contentToBlocks(msg.content, providerId).map((b: any) => b.text).filter(Boolean).join('\n');
      if (text) {
        systemParts.push(text);
      }
      continue;
    }

    if (msg.role === 'tool') {
      pushMessage(messages, 'user', [
        {
          type: 'tool_result',
          tool_use_id: msg.tool_call_id,
          content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? ''),
        },
      ]);
      continue;
    }

    if (msg.role === 'assistant') {
      const blocks = contentToBlocks(msg.content, providerId);
      for (const call of msg.tool_calls ?? []) {
        let input: any = {};
        try {
          input = typeof call.function?.arguments === 'string'
            ? JSON.parse(call.function.arguments || '{}')
            : call.function?.arguments ?? {};
        } catch {
          input = {};
        }
        blocks.push({
          type: 'tool_use',
          id: call.id,
          name: call.function?.name,
          input,
        });
      }
      pushMessage(messages, 'assistant', blocks);
      continue;
    }

    pushMessage(messages, 'user', contentToBlocks(msg.content, providerId));
  }

  const anthropicBody: any = {
    model: upstreamModelId,
    messages,
    max_tokens: openaiBody.max_tokens ?? openaiBody.max_completion_tokens ?? fallbackMaxTokens,
    stream: openaiBody.stream === true,
  };

  if (systemParts.length > 0) {
    const systemText = systemParts.join('\n\n');
    /**
     * A cache breakpoint on the system block, once there is enough of it to be worth one.
     *
     * An OpenAI-shaped client has no way to ask for this — there is no `cache_control` in that
     * dialect — so on the way to a real Anthropic upstream the request would arrive uncacheable no
     * matter how stable its system prompt was. Anthropic's cache prefix is ordered
     * `tools → system → messages`, so marking the *system* block caches the tool schemas with it,
     * which on an agent client is usually the larger half.
     *
     * Only for a system prompt over `CACHE_BREAKPOINT_MIN_CHARS`, and not because a shorter one would
     * error — Anthropic ignores a breakpoint below its minimum cacheable length. The reason is the
     * wire shape: a string is what every Anthropic-style upstream has always accepted, and a
     * dashboard-defined custom provider may be stricter than the real API about content blocks. Small
     * requests keep the old form and lose nothing; large ones get the win.
     */
    anthropicBody.system =
      systemText.length >= CACHE_BREAKPOINT_MIN_CHARS
        ? [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }]
        : systemText;
  }
  if (typeof openaiBody.temperature === 'number') {
    anthropicBody.temperature = openaiBody.temperature;
  }
  if (typeof openaiBody.top_p === 'number') {
    anthropicBody.top_p = openaiBody.top_p;
  }
  if (openaiBody.stop) {
    anthropicBody.stop_sequences = Array.isArray(openaiBody.stop) ? openaiBody.stop : [openaiBody.stop];
  }

  if (Array.isArray(openaiBody.tools) && openaiBody.tools.length > 0) {
    anthropicBody.tools = openaiBody.tools
      .filter((tool: any) => tool?.function)
      .map((tool: any) => ({
        name: tool.function.name,
        description: tool.function.description,
        input_schema: tool.function.parameters ?? { type: 'object', properties: {} },
      }));

    const choice = openaiBody.tool_choice;
    if (choice === 'required') {
      anthropicBody.tool_choice = { type: 'any' };
    } else if (choice === 'none') {
      delete anthropicBody.tools;
    } else if (choice === 'auto') {
      anthropicBody.tool_choice = { type: 'auto' };
    } else if (choice?.type === 'function' && choice.function?.name) {
      anthropicBody.tool_choice = { type: 'tool', name: choice.function.name };
    }
  }

  return anthropicBody;
}

function mapStopReason(stopReason: string | null | undefined): string {
  switch (stopReason) {
    case 'tool_use':
      return 'tool_calls';
    case 'max_tokens':
      return 'length';
    case 'stop_sequence':
    case 'end_turn':
      return 'stop';
    default:
      return 'stop';
  }
}

/**
 * Convert a complete Anthropic message response into an OpenAI chat completion.
 */
export async function finalizeAnthropicToOpenAIResponse(
  anthropicRes: Response,
  requestedModelId: string,
): Promise<Response> {
  let data: any;
  try {
    data = await anthropicRes.json();
  } catch {
    return anthropicRes;
  }

  const textParts: string[] = [];
  const reasoningParts: string[] = [];
  const toolCalls: any[] = [];

  for (const block of data.content ?? []) {
    if (block.type === 'text' && typeof block.text === 'string') {
      textParts.push(block.text);
    } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
      reasoningParts.push(block.thinking);
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    }
  }

  const message: any = {
    role: 'assistant',
    content: textParts.join('') || null,
  };
  if (reasoningParts.length > 0) {
    message.reasoning_content = reasoningParts.join('');
  }
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }

  const body = {
    id: data.id || `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: requestedModelId,
    choices: [
      {
        index: 0,
        message,
        finish_reason: mapStopReason(data.stop_reason),
      },
    ],
    usage: {
      // The whole prompt, cached part included — see `promptTokens`. Anthropic's
      // `input_tokens` alone is only what the cache did not serve.
      prompt_tokens: promptTokens(data.usage) ?? 0,
      completion_tokens: data.usage?.output_tokens ?? 0,
      total_tokens: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
      // The other half of the breakpoint above: an upstream that honoured it says so as
      // `cache_read_input_tokens`, and an OpenAI client only understands `prompt_tokens_details`.
      ...openAiCacheUsage(cacheReadTokens(data.usage)),
    },
  };

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

/**
 * Convert an Anthropic SSE stream into OpenAI chat-completion chunks.
 */
export function createAnthropicToOpenAIStreamTransformer(requestedModelId: string) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const completionId = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  let buffer = '';
  let sentRole = false;
  let finished = false;
  let inputTokens = 0;
  let outputTokens = 0;
  /** Cache-read tokens, absent until the upstream mentions them. See `core/usage-cache.ts`. */
  let cachedTokens: number | undefined;

  /** Anthropic block index → OpenAI tool_calls array index. */
  const toolCallIndexByBlock = new Map<number, number>();
  let nextToolCallIndex = 0;

  const chunk = (delta: any, finishReason: string | null = null) => ({
    id: completionId,
    object: 'chat.completion.chunk',
    created,
    model: requestedModelId,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });

  const emit = (controller: TransformStreamDefaultController, payload: any) => {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
  };

  const finish = (controller: TransformStreamDefaultController, stopReason: string) => {
    if (finished) {
      return;
    }
    finished = true;

    emit(controller, chunk({}, mapStopReason(stopReason)));
    emit(controller, {
      id: completionId,
      object: 'chat.completion.chunk',
      created,
      model: requestedModelId,
      choices: [],
      usage: {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
        ...openAiCacheUsage(cachedTokens),
      },
    });
    controller.enqueue(encoder.encode('data: [DONE]\n\n'));
  };

  const handleEvent = (event: any, controller: TransformStreamDefaultController) => {
    switch (event.type) {
      case 'message_start': {
        // Cached tokens are part of the prompt, and Anthropic reports them beside it, not in it.
        inputTokens = promptTokens(event.message?.usage) ?? 0;
        outputTokens = event.message?.usage?.output_tokens ?? 0;
        // `message_start` is the only event that carries the cache counts.
        cachedTokens = cacheReadTokens(event.message?.usage) ?? cachedTokens;
        if (!sentRole) {
          sentRole = true;
          emit(controller, chunk({ role: 'assistant', content: '' }));
        }
        break;
      }

      case 'content_block_start': {
        const block = event.content_block;
        if (block?.type === 'tool_use') {
          const toolIndex = nextToolCallIndex++;
          toolCallIndexByBlock.set(event.index, toolIndex);
          emit(
            controller,
            chunk({
              tool_calls: [
                {
                  index: toolIndex,
                  id: block.id,
                  type: 'function',
                  function: { name: block.name, arguments: '' },
                },
              ],
            }),
          );
        }
        break;
      }

      case 'content_block_delta': {
        const delta = event.delta;
        if (delta?.type === 'text_delta' && delta.text) {
          emit(controller, chunk({ content: delta.text }));
        } else if (delta?.type === 'thinking_delta' && delta.thinking) {
          emit(controller, chunk({ reasoning_content: delta.thinking }));
        } else if (delta?.type === 'input_json_delta') {
          const toolIndex = toolCallIndexByBlock.get(event.index);
          if (toolIndex !== undefined) {
            emit(
              controller,
              chunk({
                tool_calls: [
                  {
                    index: toolIndex,
                    function: { arguments: delta.partial_json ?? '' },
                  },
                ],
              }),
            );
          }
        }
        break;
      }

      case 'message_delta': {
        if (typeof event.usage?.output_tokens === 'number') {
          outputTokens = event.usage.output_tokens;
        }
        if (event.delta?.stop_reason) {
          finish(controller, event.delta.stop_reason);
        }
        break;
      }

      case 'message_stop': {
        finish(controller, 'end_turn');
        break;
      }

      default:
        break;
    }
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(bytes, controller) {
      buffer += decoder.decode(bytes, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) {
          continue;
        }

        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') {
          continue;
        }

        try {
          handleEvent(JSON.parse(payload), controller);
        } catch (error) {
          console.warn('[OpenAIStream] Failed to parse Anthropic event:', error);
        }
      }
    },

    flush(controller) {
      finish(controller, 'end_turn');
    },
  });
}
