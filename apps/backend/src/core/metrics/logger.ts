import type { Statement } from 'bun:sqlite';
import { getDb } from '@/core/db';

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
  /** True when token counts came from the estimator instead of the upstream. */
  estimated: boolean;
  inputCost: number;
  outputCost: number;
  costSaved: number;
}

const BATCH_LIMIT = 50;
const FLUSH_INTERVAL_MS = 5000;
const MAX_QUEUE_SIZE = 2000;

const INSERT_SQL = `INSERT INTO token_usage_logs (
  timestamp, session_id, client_id, api_key_id, provider, model, full_model_name,
  protocol, streamed, status_code, duration_ms,
  input_tokens, output_tokens, cached_input_tokens,
  tokens_before_compression, tokens_after_compression, tokens_saved, estimated,
  input_cost, output_cost, cost_saved
) VALUES (
  $timestamp, $sessionId, $clientId, $apiKeyId, $provider, $model, $fullModelName,
  $protocol, $streamed, $statusCode, $durationMs,
  $inputTokens, $outputTokens, $cachedInputTokens,
  $tokensBefore, $tokensAfter, $tokensSaved, $estimated,
  $inputCost, $outputCost, $costSaved
)`;

/**
 * Buffers token usage rows in memory and flushes them to SQLite in batches so
 * that a slow or locked database can never stall an in-flight LLM response.
 */
class TokenMetricsLogger {
  private queue: TokenLogEntry[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private insertStatement: Statement | null = null;
  private flushTransaction: ((batch: TokenLogEntry[]) => void) | null = null;

  /**
   * Enqueue one request's metrics. Never throws — telemetry must not break proxying.
   */
  log(entry: TokenLogEntry): void {
    try {
      this.queue.push(entry);
      this.ensureTimer();

      if (this.queue.length >= BATCH_LIMIT) {
        this.flush();
      }
    } catch (error) {
      console.warn('[Metrics] Failed to enqueue token usage:', error);
    }
  }

  /**
   * Write everything currently queued. Safe to call at any time.
   */
  flush(): void {
    if (this.queue.length === 0) {
      return;
    }

    const batch = this.queue;
    this.queue = [];

    try {
      this.getFlushTransaction()(batch);
    } catch (error) {
      console.error('[Metrics] Failed to persist token usage batch:', error);

      // Put the batch back so a transient lock does not lose data, but cap the
      // buffer so a permanently broken database cannot leak memory.
      this.queue = [...batch, ...this.queue].slice(-MAX_QUEUE_SIZE);
    }
  }

  /**
   * Number of rows waiting to be written — surfaced on the metrics dashboard.
   */
  pendingCount(): number {
    return this.queue.length;
  }

  private ensureTimer(): void {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    // Do not hold the process open just for the metrics flush loop.
    this.timer.unref?.();
  }

  private getFlushTransaction(): (batch: TokenLogEntry[]) => void {
    if (this.flushTransaction) {
      return this.flushTransaction;
    }

    const db = getDb();
    this.insertStatement = db.prepare(INSERT_SQL);
    const statement = this.insertStatement;

    this.flushTransaction = db.transaction((batch: TokenLogEntry[]) => {
      for (const entry of batch) {
        statement.run({
          $timestamp: entry.timestamp,
          $sessionId: entry.sessionId ?? null,
          $clientId: entry.clientId,
          $apiKeyId: entry.apiKeyId ?? null,
          $provider: entry.provider,
          $model: entry.model,
          $fullModelName: entry.fullModelName,
          $protocol: entry.protocol,
          $streamed: entry.streamed ? 1 : 0,
          $statusCode: entry.statusCode,
          $durationMs: Math.round(entry.durationMs),
          $inputTokens: Math.round(entry.inputTokens),
          $outputTokens: Math.round(entry.outputTokens),
          $cachedInputTokens: Math.round(entry.cachedInputTokens),
          $tokensBefore: entry.tokensBeforeCompression ?? null,
          $tokensAfter: entry.tokensAfterCompression ?? null,
          $tokensSaved: Math.round(entry.tokensSaved),
          $estimated: entry.estimated ? 1 : 0,
          $inputCost: entry.inputCost,
          $outputCost: entry.outputCost,
          $costSaved: entry.costSaved,
        });
      }
    });

    return this.flushTransaction;
  }
}

export const tokenMetricsLogger = new TokenMetricsLogger();
