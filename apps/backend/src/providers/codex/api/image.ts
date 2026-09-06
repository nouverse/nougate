/**
 * Codex image generation via Responses API + SSE.
 *
 * Uses the SAME Responses API endpoint with `tools: [{type: "image_generation", ...}]` —
 * NOT a separate image endpoint.
 *
 * Ported from 9router's `handlers/imageProviders/codex.js`.
 */

import { randomUUID } from 'node:crypto';

const CODEX_REF_DETAIL = 'high';
const IMAGE_SUFFIX = '-image';

export function stripImageSuffix(model: string): string {
  return model.endsWith(IMAGE_SUFFIX) ? model.slice(0, -IMAGE_SUFFIX.length) : model;
}

function toDataUrl(input: any): string | null {
  if (!input || typeof input !== 'string') return null;
  if (/^data:image\//i.test(input) || /^https?:\/\//i.test(input)) return input;
  return `data:image/png;base64,${input}`;
}

function buildContent(prompt: string, refs: string[], detail = CODEX_REF_DETAIL): any[] {
  const content: any[] = [];
  refs.forEach((url, index) => {
    content.push({ type: 'input_text', text: `<image name=image${index + 1}>` });
    content.push({ type: 'input_image', image_url: url, detail });
    content.push({ type: 'input_text', text: '</image>' });
  });
  content.push({ type: 'input_text', text: prompt });
  return content;
}

/**
 * Build the Responses API body for image generation.
 */
export function buildImageBody(model: string, body: Record<string, any>): Record<string, any> {
  const refs: string[] = [];
  if (Array.isArray(body.images)) {
    body.images.forEach((i: any) => { const u = toDataUrl(i); if (u) refs.push(u); });
  }
  const single = toDataUrl(body.image);
  if (single) refs.push(single);

  const detail = body.image_detail || CODEX_REF_DETAIL;
  const imgTool: Record<string, any> = {
    type: 'image_generation',
    output_format: (body.output_format || 'png').toLowerCase(),
  };
  if (body.size && body.size !== '') imgTool.size = body.size;
  if (body.quality && body.quality !== '') imgTool.quality = body.quality;
  if (body.background && body.background !== '') imgTool.background = body.background;

  return {
    model: stripImageSuffix(model),
    instructions: '',
    input: [{ type: 'message', role: 'user', content: buildContent(body.prompt, refs, detail) }],
    tools: [imgTool],
    tool_choice: 'auto',
    parallel_tool_calls: false,
    prompt_cache_key: randomUUID(),
    stream: true,
    store: false,
    reasoning: null,
  };
}

interface ParseCallbacks {
  onProgress?: (info: { stage: string; bytesReceived: number }) => void;
  onPartialImage?: (info: { b64_json: string; index: number }) => void;
}

/**
 * Parse Codex SSE stream → final base64 image.
 */
export async function parseImageStream(
  response: Response,
  callbacks: ParseCallbacks = {},
): Promise<string | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let imageB64: string | null = null;
  let lastEvent: string | null = null;
  let bytesReceived = 0;
  let lastProgressLogMs = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytesReceived += value?.byteLength || 0;
    buffer += decoder.decode(value, { stream: true });

    let sepIdx: number;
    while ((sepIdx = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, sepIdx);
      buffer = buffer.slice(sepIdx + 2);

      const lines = block.split('\n');
      let eventName: string | null = null;
      let dataStr = '';
      for (const line of lines) {
        if (line.startsWith('event:')) eventName = line.slice(6).trim();
        else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
      }
      if (!eventName) continue;
      if (eventName !== lastEvent) lastEvent = eventName;

      const now = Date.now();
      if (callbacks.onProgress && now - lastProgressLogMs > 200) {
        lastProgressLogMs = now;
        callbacks.onProgress({ stage: eventName, bytesReceived });
      }

      if (eventName === 'response.image_generation_call.partial_image' && dataStr) {
        try {
          const data = JSON.parse(dataStr);
          if (callbacks.onPartialImage && data?.partial_image_b64) {
            callbacks.onPartialImage({ b64_json: data.partial_image_b64, index: data.partial_image_index });
          }
        } catch { /* ignore */ }
      }

      if (eventName === 'response.output_item.done' && dataStr) {
        try {
          const data = JSON.parse(dataStr);
          const item = data?.item;
          if (item?.type === 'image_generation_call' && item.result) {
            imageB64 = item.result;
          }
        } catch { /* ignore */ }
      }
    }
  }
  return imageB64;
}

/**
 * Build an SSE response that pipes codex progress + partial + done events to the client.
 */
export function buildImageSseResponse(
  providerResponse: Response,
  onSuccess?: () => Promise<void>,
): Response {
  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (event: string, data: any) => {
        controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      try {
        const b64 = await parseImageStream(providerResponse, {
          onProgress: (info) => send('progress', info),
          onPartialImage: (info) => send('partial_image', info),
        });
        if (!b64) {
          send('error', { message: 'Codex did not return an image. Account may not be entitled (Plus/Pro required).' });
        } else {
          if (onSuccess) await onSuccess();
          send('done', { created: Math.floor(Date.now() / 1000), data: [{ b64_json: b64 }] });
        }
      } catch (err: any) {
        send('error', { message: err?.message || 'Stream failed' });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
