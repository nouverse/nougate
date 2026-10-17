import { getDb, t } from '@/core/db';
import { armBeat, onBeat } from '@/core/db/heartbeat';

export interface TokenLogEntry {
  timestamp: number;
  sessionId?: string;
  clientId: string;
  apiKeyId?: string | null;
  provider: string;
  model: string;
  fullModelName: string;
  protocol: string;
  streamed: boolean;
  statusCode: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  tokensBeforeCompression?: number | null;
  tokensAfterCompression?: number | null;
  tokensSaved: number;
  /** Per-engine attribution; serialised to JSON on write. */
  compressionBreakdown?: Array<{ engine: string; tokensSaved: number }> | null;
  /** True when token counts came from the estimator instead of the upstream. */
  estimated: boolean;
  inputCost: number;
  outputCost: number;
  /** What compression saved. */
  costSaved: number;
  /** What the prompt cache saved — a separate engine, so a separate number. */
  cacheCostSaved: number;
}

const BATCH_LIMIT = 50;
const MAX_QUEUE_SIZE = 2000;

/**
 * Buffers token usage rows in memory and flushes them to SQLite in batches so
 * that a slow or locked database can never stall an in-flight LLM response.
 *
 * Written on the gateway's one heartbeat (`core/db/heartbeat.ts`) — every 30 s inside a host, 5 s on its own — or
 * at once when a batch fills.
 */
class TokenMetricsLogger {
  private queue: TokenLogEntry[] = [];
  /** Guards against two flushes overlapping once writes became async. */
  private flushing = false;

  /**
   * Enqueue one request's metrics. Never throws — telemetry must not break proxying.
   */
  log(entry: TokenLogEntry): void {
    try {
      this.queue.push(entry);
      armBeat();

      if (this.queue.length >= BATCH_LIMIT) {
        void this.flush();
      }
    } catch (error) {
      console.warn('[Metrics] Failed to enqueue token usage:', error);
    }
  }

  /**
   * Write everything currently queued. Safe to call at any time.
   */
  async flush(): Promise<void> {
    if (this.queue.length === 0 || this.flushing) {
      return;
    }

    this.flushing = true;
    const batch = this.queue;
    this.queue = [];

    try {
      await getDb().insert(t.tokenUsageLogs).values(batch.map(toRow));
    } catch (error) {
      console.error('[Metrics] Failed to persist token usage batch:', error);

      // Put the batch back so a transient failure does not lose data, but cap
      // the buffer so a permanently broken database cannot leak memory. The next beat tries again.
      this.queue = [...batch, ...this.queue].slice(-MAX_QUEUE_SIZE);
      armBeat();
    } finally {
      this.flushing = false;
    }
  }

  /**
   * Number of rows waiting to be written — surfaced on the metrics dashboard.
   */
  pendingCount(): number {
    return this.queue.length;
  }
}

/**
 * Map one buffered entry onto its table row.
 */
function toRow(entry: TokenLogEntry) {
  return {
    timestamp: entry.timestamp,
    sessionId: entry.sessionId ?? null,
    clientId: entry.clientId,
    apiKeyId: entry.apiKeyId ?? null,
    provider: entry.provider,
    model: entry.model,
    fullModelName: entry.fullModelName,
    protocol: entry.protocol,
    streamed: entry.streamed ? 1 : 0,
    statusCode: entry.statusCode,
    durationMs: Math.round(entry.durationMs),
    inputTokens: Math.round(entry.inputTokens),
    outputTokens: Math.round(entry.outputTokens),
    cachedInputTokens: Math.round(entry.cachedInputTokens),
    tokensBeforeCompression: entry.tokensBeforeCompression ?? null,
    tokensAfterCompression: entry.tokensAfterCompression ?? null,
    tokensSaved: Math.round(entry.tokensSaved),
    compressionBreakdown: entry.compressionBreakdown?.length
      ? JSON.stringify(
          Object.fromEntries(
            entry.compressionBreakdown.map((item) => [item.engine, Math.round(item.tokensSaved)]),
          ),
        )
      : null,
    estimated: entry.estimated ? 1 : 0,
    inputCost: entry.inputCost,
    outputCost: entry.outputCost,
    costSaved: entry.costSaved,
    cacheCostSaved: entry.cacheCostSaved,
  };
}

export const tokenMetricsLogger = new TokenMetricsLogger();
onBeat(() => tokenMetricsLogger.flush());
