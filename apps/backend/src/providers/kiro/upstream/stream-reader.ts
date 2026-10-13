/**
 * Pulls Kiro's response body through the interpreter one upstream read at a time.
 *
 * Pull-based on purpose: nothing is read from upstream until the client side asks for more, so a
 * slow client applies backpressure all the way to Kiro instead of the gateway accumulating the
 * answer in memory.
 */

import type { KiroEvent, KiroStreamInterpreter } from '../mappers/stream-events';

/** No bytes for this long means the upstream has stalled; the turn is failed rather than hung. */
export const KIRO_STREAM_IDLE_TIMEOUT_MS = 180_000;

export class KiroResponseReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private done = false;

  constructor(
    body: ReadableStream<Uint8Array>,
    readonly interpreter: KiroStreamInterpreter,
    private readonly idleTimeoutMs = KIRO_STREAM_IDLE_TIMEOUT_MS,
  ) {
    this.reader = body.getReader();
  }

  /**
   * The events produced by the next upstream read. An empty array means frames arrived that the
   * client has nothing to see for (metering, context usage) — the caller may send a keepalive.
   * `null` means the stream is over and its terminal event has already been returned.
   */
  async next(): Promise<KiroEvent[] | null> {
    if (this.done) return null;

    let result: { done: boolean; value?: Uint8Array };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      result = await Promise.race([
        this.reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Kiro stream stalled for ${this.idleTimeoutMs / 1000}s`)), this.idleTimeoutMs);
        }),
      ]);
    } catch (error) {
      this.done = true;
      void this.reader.cancel('kiro stream read failed').catch(() => {});
      return [this.interpreter.fail('kiro_upstream_read_error', (error as Error).message || 'Kiro stream read failed', 502)];
    } finally {
      clearTimeout(timer);
    }

    if (result.done) {
      this.done = true;
      return this.interpreter.end();
    }

    const events = result.value ? this.interpreter.pushBytes(result.value) : [];
    if (this.interpreter.isFinished) {
      this.done = true;
      void this.reader.cancel('kiro stream finished').catch(() => {});
    }
    return events;
  }

  /**
   * Read until the first client-visible event or the end, whichever comes first. The executor uses
   * this to see an in-stream refusal (throttling, an expired token) before any byte has gone to
   * the client — the only point at which trying another account is still possible.
   */
  async prime(): Promise<KiroEvent[]> {
    const primed: KiroEvent[] = [];
    while (primed.length === 0) {
      const events = await this.next();
      if (events === null) break;
      primed.push(...events);
    }
    return primed;
  }

  async cancel(reason: string): Promise<void> {
    this.done = true;
    await this.reader.cancel(reason).catch(() => {});
  }
}

/** Every event, starting with the ones already primed. Empty batches are yielded as keepalive hints. */
export async function* readEvents(reader: KiroResponseReader, primed: KiroEvent[]): AsyncGenerator<KiroEvent[]> {
  if (primed.length > 0) yield primed;
  while (true) {
    const events = await reader.next();
    if (events === null) return;
    yield events;
  }
}
