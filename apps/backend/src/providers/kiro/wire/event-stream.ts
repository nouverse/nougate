/**
 * AWS EventStream binary framing — the transport Kiro's `GenerateAssistantResponse` answers in.
 *
 * Frame layout, all integers big-endian:
 *
 *   [totalLength u32][headersLength u32][preludeCrc u32][headers…][payload…][messageCrc u32]
 *
 * Both CRCs are checked. A frame that fails either is a corrupt stream, not a short one, and is
 * reported as such rather than decoded into a silently truncated model answer.
 *
 * ## Why a decoder object and not a parse-the-whole-body function
 *
 * Kiro's 9router executor collected up to 8 MB of decoded output before the client saw a byte.
 * Here the decoder is fed whatever `fetch` hands over, yields every frame that is now complete, and
 * keeps only the tail of an unfinished one. Memory is bounded by the largest single frame, not the
 * length of the answer.
 */

/** Protocol bounds shared by every EventStream consumer. */
export const EVENTSTREAM_LIMITS = {
  /** AWS caps a message at 16 MiB; Kiro has been seen close to it with large tool inputs. */
  maxMessageBytes: 24 * 1024 * 1024,
  maxHeadersBytes: 128 * 1024,
} as const;

const PRELUDE_BYTES = 12;
const MIN_FRAME_BYTES = 16;

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) {
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return value >>> 0;
});

/** IEEE CRC-32, as used by both EventStream checksums. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC32_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A header value, typed as the frame declared it. Byte-array headers stay bytes. */
export type EventStreamHeaderValue = boolean | number | string | Uint8Array;

export interface EventStreamFrame {
  headers: Record<string, EventStreamHeaderValue>;
  /** The payload parsed as JSON, or `null` when the frame carried none. */
  payload: any;
}

/** Thrown for any framing or checksum violation. */
export class EventStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventStreamError';
  }
}

const textDecoder = new TextDecoder();

/**
 * Decode exactly one frame. Throws on any integrity failure rather than returning partial data.
 */
export function parseEventFrame(data: Uint8Array): EventStreamFrame {
  if (data.byteLength < MIN_FRAME_BYTES) {
    throw new EventStreamError('EventStream frame is shorter than 16 bytes');
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const totalLength = view.getUint32(0, false);
  const headersLength = view.getUint32(4, false);

  if (totalLength !== data.byteLength) {
    throw new EventStreamError('EventStream frame length does not match its prelude');
  }
  assertFrameBounds(totalLength, headersLength);
  if (view.getUint32(8, false) !== crc32(data.subarray(0, 8))) {
    throw new EventStreamError('EventStream prelude CRC mismatch');
  }
  if (view.getUint32(totalLength - 4, false) !== crc32(data.subarray(0, totalLength - 4))) {
    throw new EventStreamError('EventStream message CRC mismatch');
  }

  const headers: Record<string, EventStreamHeaderValue> = Object.create(null);
  const headerEnd = PRELUDE_BYTES + headersLength;
  let offset = PRELUDE_BYTES;

  const need = (count: number) => {
    if (offset + count > headerEnd) {
      throw new EventStreamError('EventStream header exceeds its declared bounds');
    }
  };

  while (offset < headerEnd) {
    need(1);
    const nameLength = data[offset++]!;
    need(nameLength + 1);
    const name = textDecoder.decode(data.subarray(offset, offset + nameLength));
    offset += nameLength;
    if (name in headers) throw new EventStreamError(`EventStream contains duplicate header: ${name}`);
    const type = data[offset++]!;

    switch (type) {
      case 0:
      case 1:
        headers[name] = type === 0;
        break;
      case 2:
        need(1);
        headers[name] = view.getInt8(offset);
        offset += 1;
        break;
      case 3:
        need(2);
        headers[name] = view.getInt16(offset, false);
        offset += 2;
        break;
      case 4:
        need(4);
        headers[name] = view.getInt32(offset, false);
        offset += 4;
        break;
      case 5:
      case 8:
        // int64 and timestamp: nothing in Kiro's stream reads them, so they are skipped rather
        // than squeezed into a lossy JS number.
        need(8);
        offset += 8;
        break;
      case 6:
      case 7: {
        need(2);
        const valueLength = view.getUint16(offset, false);
        offset += 2;
        need(valueLength);
        const bytes = data.subarray(offset, offset + valueLength);
        headers[name] = type === 7 ? textDecoder.decode(bytes) : bytes.slice();
        offset += valueLength;
        break;
      }
      case 9:
        // uuid
        need(16);
        offset += 16;
        break;
      default:
        throw new EventStreamError(`EventStream header ${name} has unknown type ${type}`);
    }
  }

  const payloadBytes = data.subarray(headerEnd, totalLength - 4);
  if (payloadBytes.byteLength === 0) return { headers, payload: null };
  const payloadText = textDecoder.decode(payloadBytes);
  if (!payloadText.trim()) return { headers, payload: null };
  try {
    return { headers, payload: JSON.parse(payloadText) };
  } catch (error) {
    throw new EventStreamError(`EventStream payload is not valid JSON (${(error as Error).message})`);
  }
}

function assertFrameBounds(totalLength: number, headersLength: number): void {
  if (
    totalLength < MIN_FRAME_BYTES ||
    totalLength > EVENTSTREAM_LIMITS.maxMessageBytes ||
    headersLength > EVENTSTREAM_LIMITS.maxHeadersBytes ||
    headersLength > totalLength - MIN_FRAME_BYTES
  ) {
    throw new EventStreamError('EventStream frame bounds are invalid');
  }
}

/**
 * Incremental decoder: push bytes as they arrive, take complete frames out.
 *
 * Only the bytes of the frame currently being assembled are retained. The prelude CRC is checked
 * as soon as 12 bytes are in, so a desynchronised stream is caught before it can claim a 24 MB
 * frame and make the decoder wait for it.
 */
export class EventStreamDecoder {
  private pending: Uint8Array = new Uint8Array(0);

  /** Bytes held for a frame that has not finished arriving. */
  get bufferedBytes(): number {
    return this.pending.byteLength;
  }

  push(chunk: Uint8Array): EventStreamFrame[] {
    this.pending = this.pending.byteLength === 0 ? chunk : concat(this.pending, chunk);
    const frames: EventStreamFrame[] = [];

    while (this.pending.byteLength >= PRELUDE_BYTES) {
      const view = new DataView(this.pending.buffer, this.pending.byteOffset, this.pending.byteLength);
      if (view.getUint32(8, false) !== crc32(this.pending.subarray(0, 8))) {
        throw new EventStreamError('EventStream prelude CRC mismatch');
      }
      const totalLength = view.getUint32(0, false);
      assertFrameBounds(totalLength, view.getUint32(4, false));
      if (this.pending.byteLength < totalLength) break;

      frames.push(parseEventFrame(this.pending.subarray(0, totalLength)));
      this.pending = this.pending.subarray(totalLength);
    }

    // Detach the tail from the (possibly large) chunk it was cut from.
    if (this.pending.byteLength > 0 && this.pending.byteOffset > 0) {
      this.pending = this.pending.slice();
    }
    return frames;
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

/**
 * Build one frame with string-typed headers. Used by tests and fixtures only — nothing on the
 * request path emits EventStream — but it lives beside the decoder so the two stay in step.
 */
export function encodeEventFrame(headers: Record<string, string> = {}, payload: unknown = null): Uint8Array {
  const encoder = new TextEncoder();
  const headerChunks = Object.entries(headers).map(([name, value]) => {
    const nameBytes = encoder.encode(name);
    const valueBytes = encoder.encode(String(value));
    const chunk = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length);
    const view = new DataView(chunk.buffer);
    let cursor = 0;
    chunk[cursor++] = nameBytes.length;
    chunk.set(nameBytes, cursor);
    cursor += nameBytes.length;
    chunk[cursor++] = 7;
    view.setUint16(cursor, valueBytes.length, false);
    cursor += 2;
    chunk.set(valueBytes, cursor);
    return chunk;
  });

  const headersLength = headerChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const payloadBytes = payload === null ? new Uint8Array(0) : encoder.encode(JSON.stringify(payload));
  const totalLength = MIN_FRAME_BYTES + headersLength + payloadBytes.length;

  const frame = new Uint8Array(totalLength);
  const view = new DataView(frame.buffer);
  view.setUint32(0, totalLength, false);
  view.setUint32(4, headersLength, false);
  view.setUint32(8, crc32(frame.subarray(0, 8)), false);

  let offset = PRELUDE_BYTES;
  for (const chunk of headerChunks) {
    frame.set(chunk, offset);
    offset += chunk.length;
  }
  frame.set(payloadBytes, offset);
  view.setUint32(totalLength - 4, crc32(frame.subarray(0, totalLength - 4)), false);
  return frame;
}
