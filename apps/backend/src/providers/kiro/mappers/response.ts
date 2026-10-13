/**
 * Turning a primed Kiro response into the client's `Response`, streamed or collected.
 *
 * Shared by both dialects; the encoder is the only dialect-specific part.
 */

import { readEvents, type KiroResponseReader } from '../upstream/stream-reader';
import type { KiroEvent } from './stream-events';

export interface KiroStreamEncoder {
  start(): string;
  encode(event: KiroEvent): string;
  keepalive(): string;
}

export const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'Access-Control-Allow-Origin': '*',
  'X-Accel-Buffering': 'no',
} as const;

/** Frames that carry nothing for the client still keep the connection visibly alive, this often. */
const KEEPALIVE_INTERVAL_MS = 10_000;

/**
 * Pipe events to the client as they decode. Each upstream read becomes at most one write; nothing
 * is accumulated beyond the encoder's few bytes of block state.
 */
export function streamKiroResponse(
  reader: KiroResponseReader,
  primed: KiroEvent[],
  encoder: KiroStreamEncoder,
  extraHeaders: Record<string, string> = {},
): Response {
  const textEncoder = new TextEncoder();
  const batches = readEvents(reader, primed);
  let started = false;
  let lastWrite = Date.now();

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        let out = '';
        if (!started) {
          started = true;
          out += encoder.start();
        }
        while (!out) {
          const next = await batches.next();
          if (next.done) {
            controller.close();
            return;
          }
          for (const event of next.value) out += encoder.encode(event);
          if (!out && Date.now() - lastWrite >= KEEPALIVE_INTERVAL_MS) out = encoder.keepalive();
        }
        lastWrite = Date.now();
        controller.enqueue(textEncoder.encode(out));
      } catch (error) {
        // An encoder or reader bug must still end the stream as a protocol error, not a hang.
        console.error('[kiro] stream failed:', error);
        controller.enqueue(
          textEncoder.encode(
            encoder.encode({ type: 'error', code: 'kiro_stream_failed', message: 'The Kiro stream failed.', status: 502 }),
          ),
        );
        controller.close();
      }
    },
    async cancel(reason) {
      await reader.cancel(String(reason ?? 'client cancelled'));
    },
  });

  return new Response(body, { status: 200, headers: { ...SSE_HEADERS, ...extraHeaders } });
}

/**
 * Read the whole turn for a non-streaming caller. Kiro has no non-streaming mode, so the events are
 * collected — this is the client asking for the complete answer, not the gateway choosing to hold it.
 * Returns the error event instead when the turn failed.
 */
export async function collectKiroEvents(
  reader: KiroResponseReader,
  primed: KiroEvent[],
): Promise<{ events: KiroEvent[]; error: Extract<KiroEvent, { type: 'error' }> | null }> {
  const events: KiroEvent[] = [];
  for await (const batch of readEvents(reader, primed)) {
    for (const event of batch) {
      if (event.type === 'error') return { events, error: event };
      events.push(event);
    }
  }
  return { events, error: null };
}
