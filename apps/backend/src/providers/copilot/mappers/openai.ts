import { getCavemanPrompt } from '@/core/caveman';

export function mapOpenAIToCopilot(openaiBody: any, upstreamModelId: string) {
  const allowedKeys = [
    'messages',
    'stream',
    'temperature',
    'top_p',
    'max_tokens',
    'max_completion_tokens',
    'stop',
    'tools',
    'tool_choice',
    'response_format',
    'stream_options',
    'n'
  ];

  const sanitizedBody: any = {
    model: upstreamModelId
  };

  for (const key of allowedKeys) {
    if (key in openaiBody && openaiBody[key] !== undefined) {
      sanitizedBody[key] = openaiBody[key];
    }
  }

  // Caveman mode: inject terse-style prompt
  const cavemanPrefix = getCavemanPrompt();
  if (cavemanPrefix && Array.isArray(sanitizedBody.messages)) {
    const firstMsg = sanitizedBody.messages[0];
    if (firstMsg && firstMsg.role === 'system') {
      firstMsg.content = `${cavemanPrefix}\n\n${firstMsg.content}`;
    } else {
      sanitizedBody.messages.unshift({ role: 'system', content: cavemanPrefix });
    }
  }

  // Sanitize messages to only include supported fields
  if (Array.isArray(sanitizedBody.messages)) {
    sanitizedBody.messages = sanitizedBody.messages.map((msg: any) => {
      const sanitizedMsg: any = {
        role: msg.role,
        content: msg.content
      };
      if (msg.name !== undefined) sanitizedMsg.name = msg.name;
      if (msg.tool_call_id !== undefined) sanitizedMsg.tool_call_id = msg.tool_call_id;
      if (msg.tool_calls !== undefined) {
        // Map any tool call formatting safely
        sanitizedMsg.tool_calls = msg.tool_calls.map((tc: any) => ({
          id: tc.id,
          type: tc.type || 'function',
          function: tc.function
        }));
      }
      return sanitizedMsg;
    });
  }

  return sanitizedBody;
}

export function createOpenAIStreamTransformer(requestedModelId: string) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) {
          controller.enqueue(encoder.encode(line + '\n'));
          continue;
        }

        const dataStr = trimmed.slice(6);
        if (dataStr === '[DONE]') {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          continue;
        }

        try {
          const data = JSON.parse(dataStr);
          data.model = requestedModelId;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch (e) {
          // If JSON parse fails, pass the raw line through
          controller.enqueue(encoder.encode(line + '\n'));
        }
      }
    },
    flush(controller) {
      if (buffer.trim()) {
        const trimmed = buffer.trim();
        if (trimmed.startsWith('data: ') && trimmed !== 'data: [DONE]') {
          const dataStr = trimmed.slice(6);
          try {
            const data = JSON.parse(dataStr);
            data.model = requestedModelId;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
          } catch (e) {
            controller.enqueue(encoder.encode(trimmed + '\n'));
          }
        } else {
          controller.enqueue(encoder.encode(trimmed + '\n'));
        }
      }
    }
  });
}

export async function finalizeOpenAIResponse(response: Response, requestedModelId: string): Promise<Response> {
  try {
    const data = await response.json();
    data.model = requestedModelId;
    return new Response(JSON.stringify(data), {
      status: response.status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      }
    });
  } catch (error) {
    return response;
  }
}
