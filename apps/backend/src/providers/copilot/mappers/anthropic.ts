import { type IModelSpec } from '@/core/interfaces';

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

  // 2. Map chat messages
  if (Array.isArray(anthropicBody.messages)) {
    for (const msg of anthropicBody.messages) {
      const role = msg.role;
      let content = msg.content;

      if (Array.isArray(content)) {
        content = content.map((c: any) => {
          if (typeof c === 'string') return c;
          if (c.type === 'text') return c.text;
          if (c.type === 'image') {
            // OpenAI format image
            return {
              type: 'image_url',
              image_url: {
                url: `data:${c.source.media_type};base64,${c.source.data}`
              }
            };
          }
          return '';
        }).filter(Boolean);
      }

      messages.push({ role, content });
    }
  }

  const openaiBody: any = {
    model: upstreamModelId,
    messages,
    stream: anthropicBody.stream ?? false,
    temperature: anthropicBody.temperature,
    top_p: anthropicBody.top_p,
    max_tokens: anthropicBody.max_tokens,
  };

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
          if (!finished) {
            finished = true;
            if (blockStarted) {
              controller.enqueue(encoder.encode(sseEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex })));
            }
            controller.enqueue(encoder.encode(sseEvent('message_delta', {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn', stop_sequence: null },
              usage: { output_tokens: 0 },
            })));
            controller.enqueue(encoder.encode(sseEvent('message_stop', { type: 'message_stop' })));
          }
          continue;
        }

        try {
          const openAIEvent = JSON.parse(dataStr);
          const choice = openAIEvent.choices?.[0];
          if (!choice) continue;

          const delta = choice.delta;
          const finishReason = choice.finish_reason;

          if (delta) {
            // Start the content block if not already started
            if (!blockStarted && (delta.content || delta.reasoning_content)) {
              controller.enqueue(encoder.encode(sseEvent('content_block_start', {
                type: 'content_block_start',
                index: blockIndex,
                content_block: { type: 'text', text: '' },
              })));
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

          if (finishReason && !finished) {
            finished = true;
            if (blockStarted) {
              controller.enqueue(encoder.encode(sseEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex })));
              blockStarted = false;
            }
            const stopReason = finishReason === 'stop' ? 'end_turn'
              : finishReason === 'length' ? 'max_tokens'
              : 'end_turn';
            controller.enqueue(encoder.encode(sseEvent('message_delta', {
              type: 'message_delta',
              delta: { stop_reason: stopReason, stop_sequence: null },
              usage: { output_tokens: 0 },
            })));
            controller.enqueue(encoder.encode(sseEvent('message_stop', { type: 'message_stop' })));
          }
        } catch (e) {
          console.warn('[Copilot Anthropic Stream] Failed to parse OpenAI chunk:', e);
        }
      }
    },

    flush(controller) {
      if (!finished) {
        finished = true;
        if (blockStarted) {
          controller.enqueue(encoder.encode(sseEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex })));
        }
        controller.enqueue(encoder.encode(sseEvent('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 0 },
        })));
        controller.enqueue(encoder.encode(sseEvent('message_stop', { type: 'message_stop' })));
      }
    }
  });
}

export async function finalizeOpenAIToAnthropicResponse(openaiRes: Response, model: string, messageId: string): Promise<Response> {
  const data = await openaiRes.json();
  const choice = data.choices?.[0];
  const content = choice?.message?.content || '';
  const reasoning = choice?.message?.reasoning_content || '';

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

  const stopReason = choice?.finish_reason === 'stop' ? 'end_turn'
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
