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
