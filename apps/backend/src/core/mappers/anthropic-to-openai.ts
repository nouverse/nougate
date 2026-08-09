/**
 * Anthropic → OpenAI request mapping, plus the reverse mapping for responses.
 *
 * Shared by every provider whose upstream speaks the OpenAI chat-completions
 * dialect (GitHub Copilot, and any user-defined custom provider set to the
 * "openai" API style).
 */
import { getCavemanPrompt } from '@/core/caveman';

/**
 * Convert an Anthropic Messages request into an OpenAI chat-completions request.
 */
export function mapAnthropicToOpenAI(anthropicBody: any, upstreamModelId: string) {
  const messages: any[] = [];

  // 1. Map system instructions
  if (anthropicBody.system) {
    if (typeof anthropicBody.system === 'string') {
      messages.push({ role: 'system', content: anthropicBody.system });
    } else if (Array.isArray(anthropicBody.system)) {
      const content = anthropicBody.system
        .map((s: any) => {
          if (typeof s === 'string') return s;
          if (s.type === 'text') return s.text;
          return '';
        })
        .join('\n');
      messages.push({ role: 'system', content });
    }
  }

  // Caveman mode: inject terse-style prompt
  const cavemanPrefix = getCavemanPrompt();
  if (cavemanPrefix && messages.length > 0 && messages[0].role === 'system') {
    messages[0].content = `${cavemanPrefix}\n\n${messages[0].content}`;
  } else if (cavemanPrefix) {
    messages.unshift({ role: 'system', content: cavemanPrefix });
  }

  // 2. Map chat messages
  if (Array.isArray(anthropicBody.messages)) {
    for (const msg of anthropicBody.messages) {
      const role = msg.role;
      const content = msg.content;

      if (typeof content === 'string') {
        messages.push({ role, content });
      } else if (Array.isArray(content)) {
        const textBlocks: string[] = [];
        const imageBlocks: any[] = [];
        const toolUseBlocks: any[] = [];
        const toolResultBlocks: any[] = [];

        for (const block of content) {
          if (typeof block === 'string') {
            textBlocks.push(block);
          } else if (block.type === 'text') {
            textBlocks.push(block.text);
          } else if (block.type === 'image') {
            imageBlocks.push({
              type: 'image_url',
              image_url: {
                url: `data:${block.source.media_type};base64,${block.source.data}`
              }
            });
          } else if (block.type === 'tool_use') {
            toolUseBlocks.push(block);
          } else if (block.type === 'tool_result') {
            toolResultBlocks.push(block);
          }
        }

        // Process based on blocks found
        if (toolResultBlocks.length > 0) {
          // If there are tool results, OpenAI requires them to be individual messages with role 'tool'
          for (const block of toolResultBlocks) {
            messages.push({
              role: 'tool',
              tool_call_id: block.tool_use_id,
              content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content || '')
            });
          }
          // If there was also text content in the same message, push it as a user message
          if (textBlocks.length > 0 || imageBlocks.length > 0) {
            const contentParts: any[] = [
              ...textBlocks.map(t => ({ type: 'text' as const, text: t })),
              ...imageBlocks
            ];
            messages.push({
              role: 'user',
              content: contentParts.length === 1 && contentParts[0].type === 'text' ? contentParts[0].text : contentParts
            });
          }
        } else if (toolUseBlocks.length > 0) {
          const tool_calls = toolUseBlocks.map((b) => ({
            id: b.id,
            type: 'function' as const,
            function: {
              name: b.name,
              arguments: typeof b.input === 'string' ? b.input : JSON.stringify(b.input || {})
            }
          }));
          messages.push({
            role: 'assistant',
            content: textBlocks.join('\n') || null,
            tool_calls
          });
        } else {
          // Normal message
          const contentParts: any[] = [
            ...textBlocks.map(t => ({ type: 'text' as const, text: t })),
            ...imageBlocks
          ];
          if (contentParts.length > 0) {
            messages.push({
              role,
              content: contentParts.length === 1 && contentParts[0].type === 'text' ? contentParts[0].text : contentParts
            });
          }
        }
      }
    }
  }

  const isStream = anthropicBody.stream ?? false;
  const openaiBody: any = {
    model: upstreamModelId,
    messages,
    stream: isStream,
    temperature: anthropicBody.temperature,
    top_p: anthropicBody.top_p,
    max_tokens: anthropicBody.max_tokens,
  };

  // Request usage stats in streaming mode so we can forward them
  if (isStream) {
    openaiBody.stream_options = { include_usage: true };
  }

  // 3. Map tools
  if (Array.isArray(anthropicBody.tools)) {
    openaiBody.tools = anthropicBody.tools.map((tool: any) => {
      if (tool.type === 'custom' || !tool.type) {
        return {
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.input_schema,
          }
        };
      }
      return tool;
    });

    if (anthropicBody.tool_choice) {
      if (anthropicBody.tool_choice.type === 'auto') {
        openaiBody.tool_choice = 'auto';
      } else if (anthropicBody.tool_choice.type === 'any') {
        openaiBody.tool_choice = 'required';
      } else if (anthropicBody.tool_choice.type === 'tool') {
        openaiBody.tool_choice = {
          type: 'function',
          function: { name: anthropicBody.tool_choice.name }
        };
      }
    }
  }

  return openaiBody;
}

function sseEvent(type: string, data: any): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function createOpenAIToAnthropicStreamTransformer(model: string, messageId: string) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  let blockIndex = 0;
  let blockStarted = false;
  let startedReasoning = false;
  let finished = false;
  let currentBlockType: 'text' | 'tool_use' | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason = 'end_turn';

  /**
   * Close the Anthropic message.
   *
   * Deliberately *not* called on `finish_reason`. OpenAI sends the usage totals
   * in a final chunk that arrives after it, so finalising early emitted
   * `message_delta` before any usage was known — and the `finished` guard then
   * stopped the real numbers from ever being sent. Anthropic clients, and our
   * own metrics which read this stream, saw zero input tokens on almost every
   * request.
   */
  const finalize = (controller: TransformStreamDefaultController) => {
    if (finished) {
      return;
    }
    finished = true;

    if (blockStarted) {
      controller.enqueue(encoder.encode(sseEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex })));
      blockStarted = false;
    }
    controller.enqueue(encoder.encode(sseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    })));
    controller.enqueue(encoder.encode(sseEvent('message_stop', { type: 'message_stop' })));
  };

  return new TransformStream({
    start(controller) {
      const msgStart = {
        type: 'message_start',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      };
      controller.enqueue(encoder.encode(sseEvent('message_start', msgStart)));
    },

    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const dataStr = trimmed.slice(6);
        
        if (dataStr === '[DONE]') {
          finalize(controller);
          continue;
        }

        try {
          const openAIEvent = JSON.parse(dataStr);

          // Capture usage from the final chunk (sent when stream_options.include_usage is true)
          if (openAIEvent.usage) {
            inputTokens = openAIEvent.usage.prompt_tokens || 0;
            outputTokens = openAIEvent.usage.completion_tokens || 0;
          }

          const choice = openAIEvent.choices?.[0];
          if (!choice) continue;

          const delta = choice.delta;
          const finishReason = choice.finish_reason;

          if (delta) {
            // 1. Handle tool calls streaming
            if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
              for (const toolCall of delta.tool_calls) {
                if (toolCall.id) {
                  // Close active block first if there is one
                  if (blockStarted) {
                    controller.enqueue(encoder.encode(sseEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex })));
                    blockIndex++;
                  }
                  
                  currentBlockType = 'tool_use';
                  blockStarted = true;

                  controller.enqueue(encoder.encode(sseEvent('content_block_start', {
                    type: 'content_block_start',
                    index: blockIndex,
                    content_block: {
                      type: 'tool_use',
                      id: toolCall.id,
                      name: toolCall.function?.name || '',
                      input: {}
                    }
                  })));
                }

                if (toolCall.function?.arguments) {
                  controller.enqueue(encoder.encode(sseEvent('content_block_delta', {
                    type: 'content_block_delta',
                    index: blockIndex,
                    delta: {
                      type: 'input_json_delta',
                      partial_json: toolCall.function.arguments
                    }
                  })));
                }
              }
            }
            // 2. Handle text content / reasoning streaming
            else if (delta.content || delta.reasoning_content) {
              if (blockStarted && currentBlockType === 'tool_use') {
                controller.enqueue(encoder.encode(sseEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex })));
                blockIndex++;
                blockStarted = false;
              }

              if (!blockStarted) {
                controller.enqueue(encoder.encode(sseEvent('content_block_start', {
                  type: 'content_block_start',
                  index: blockIndex,
                  content_block: { type: 'text', text: '' },
                })));
                currentBlockType = 'text';
                blockStarted = true;
              }

              if (delta.reasoning_content) {
                if (!startedReasoning) {
                  startedReasoning = true;
                  controller.enqueue(encoder.encode(sseEvent('content_block_delta', {
                    type: 'content_block_delta',
                    index: blockIndex,
                    delta: { type: 'text_delta', text: '<thinking>\n' },
                  })));
                }
                controller.enqueue(encoder.encode(sseEvent('content_block_delta', {
                  type: 'content_block_delta',
                  index: blockIndex,
                  delta: { type: 'text_delta', text: delta.reasoning_content },
                })));
              } else if (delta.content) {
                if (startedReasoning) {
                  startedReasoning = false;
                  controller.enqueue(encoder.encode(sseEvent('content_block_delta', {
                    type: 'content_block_delta',
                    index: blockIndex,
                    delta: { type: 'text_delta', text: '\n</thinking>\n\n' },
                  })));
                }
                controller.enqueue(encoder.encode(sseEvent('content_block_delta', {
                  type: 'content_block_delta',
                  index: blockIndex,
                  delta: { type: 'text_delta', text: delta.content },
                })));
              }
            }
          }

          if (finishReason) {
            // Record why it ended and close the open block, but leave the
            // message open — the usage totals are still in flight.
            stopReason = finishReason === 'tool_calls' ? 'tool_use'
              : finishReason === 'length' ? 'max_tokens'
              : 'end_turn';
            if (blockStarted) {
              controller.enqueue(encoder.encode(sseEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex })));
              blockStarted = false;
            }
          }
        } catch (e) {
          console.warn('[AnthropicStream] Failed to parse OpenAI chunk:', e);
        }
      }
    },

    // Upstreams that end without a [DONE] line still get a properly closed
    // message, with whatever usage did arrive.
    flush(controller) {
      finalize(controller);
    }
  });
}

export async function finalizeOpenAIToAnthropicResponse(openaiRes: Response, model: string, messageId: string): Promise<Response> {
  const data = await openaiRes.json();
  const choice = data.choices?.[0];
  const message = choice?.message;
  const content = message?.content || '';
  const reasoning = message?.reasoning_content || '';
  const toolCalls = message?.tool_calls;

  const finalContent: any[] = [];
  if (reasoning) {
    finalContent.push({
      type: 'text',
      text: `<thinking>\n${reasoning}\n</thinking>\n\n${content}`
    });
  } else if (content) {
    finalContent.push({
      type: 'text',
      text: content
    });
  }

  if (Array.isArray(toolCalls)) {
    for (const tc of toolCalls) {
      finalContent.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input: typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments || '{}') : (tc.function.arguments || {})
      });
    }
  }

  const stopReason = choice?.finish_reason === 'tool_calls' ? 'tool_use'
    : choice?.finish_reason === 'stop' ? 'end_turn'
    : choice?.finish_reason === 'length' ? 'max_tokens'
    : 'end_turn';

  const responseBody = {
    id: messageId,
    type: 'message',
    role: 'assistant',
    model,
    content: finalContent,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: data.usage?.prompt_tokens || 0,
      output_tokens: data.usage?.completion_tokens || 0,
    }
  };

  return new Response(JSON.stringify(responseBody), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    }
  });
}
