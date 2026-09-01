import { and, lt, sql } from 'drizzle-orm';
import { dialect, getDb, t, timeBucket } from '@/core/db';
import { tokenMetricsLogger } from '@/core/metrics/logger';
import { retentionDays } from '@/core/metrics/retention';

const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000; // hourly

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Fold detail rows into the daily rollup table.
 *
 * Only whole days that have already passed are rolled up, so today's numbers
 * are never double-counted between the detail table and the rollups.
 */
export async function runRollup(): Promise<number> {
  const logs = t.tokenUsageLogs;
  const rollups = t.tokenUsageDailyRollups;
  const todayStartMs = new Date(new Date().toISOString().slice(0, 10)).getTime();

  const day = timeBucket(logs.timestamp, 'day');
  // COALESCE, because detail rows store NULL for "no key" while rollups use ''.
  const keyId = sql<string>`coalesce(${logs.apiKeyId}, '')`;

  const grouped = await getDb()
    .select({
      date: day,
      provider: logs.provider,
      model: logs.model,
      fullModelName: logs.fullModelName,
      clientId: logs.clientId,
      apiKeyId: keyId,
      totalRequests: sql<number>`count(*)`,
      totalInputTokens: sql<number>`sum(${logs.inputTokens})`,
      totalOutputTokens: sql<number>`sum(${logs.outputTokens})`,
      totalTokensSaved: sql<number>`sum(${logs.tokensSaved})`,
      totalInputCost: sql<number>`sum(${logs.inputCost})`,
      totalOutputCost: sql<number>`sum(${logs.outputCost})`,
      totalCostSaved: sql<number>`sum(${logs.costSaved})`,
      // COALESCE, because these two columns were added to tables that had been collecting for months
      // — every row written before that has NULL, and a SUM over NULLs is NULL, not 0.
      totalCachedInputTokens: sql<number>`coalesce(sum(${logs.cachedInputTokens}), 0)`,
      totalCacheCostSaved: sql<number>`coalesce(sum(${logs.cacheCostSaved}), 0)`,
    })
    .from(logs)
    .where(lt(logs.timestamp, todayStartMs))
    .groupBy(day, logs.provider, logs.model, logs.fullModelName, logs.clientId, keyId);

  if (grouped.length === 0) {
    return 0;
  }

  await getDb()
    .insert(rollups)
    .values(
      grouped.map((row) => ({
        date: row.date,
        provider: row.provider,
        model: row.model,
        fullModelName: row.fullModelName,
        clientId: row.clientId,
        apiKeyId: row.apiKeyId,
        totalRequests: Number(row.totalRequests),
        totalInputTokens: Number(row.totalInputTokens),
        totalOutputTokens: Number(row.totalOutputTokens),
        totalTokensSaved: Number(row.totalTokensSaved),
        totalInputCost: Number(row.totalInputCost),
        totalOutputCost: Number(row.totalOutputCost),
        totalCostSaved: Number(row.totalCostSaved),
        totalCachedInputTokens: Number(row.totalCachedInputTokens),
        totalCacheCostSaved: Number(row.totalCacheCostSaved),
      })),
    )
    .onConflictDoUpdate({
      target: [rollups.date, rollups.fullModelName, rollups.clientId, rollups.apiKeyId],
      set: {
        totalRequests: sql`excluded.total_requests`,
        totalInputTokens: sql`excluded.total_input_tokens`,
        totalOutputTokens: sql`excluded.total_output_tokens`,
        totalTokensSaved: sql`excluded.total_tokens_saved`,
        totalInputCost: sql`excluded.total_input_cost`,
        totalOutputCost: sql`excluded.total_output_cost`,
        totalCostSaved: sql`excluded.total_cost_saved`,
        totalCachedInputTokens: sql`excluded.total_cached_input_tokens`,
        totalCacheCostSaved: sql`excluded.total_cache_cost_saved`,
      },
    });

  return grouped.length;
}

/**
 * Drop data past its retention window.
 *
 * Detail rows are pruned only after they have been rolled up, so long-range
 * charts keep working off the aggregate table.
 */
export async function runPruning(): Promise<{ prunedLogs: number; prunedRollups: number }> {
  const { detail, rollup } = retentionDays();

  const detailCutoff = Date.now() - detail * 24 * 60 * 60 * 1000;
  const rollupCutoff = new Date(Date.now() - rollup * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  // Counted first: neither driver reports affected rows the same way.
  const [logCount] = await getDb()
    .select({ total: sql<number>`count(*)` })
    .from(t.tokenUsageLogs)
    .where(lt(t.tokenUsageLogs.timestamp, detailCutoff));
  const [rollupCount] = await getDb()
    .select({ total: sql<number>`count(*)` })
    .from(t.tokenUsageDailyRollups)
    .where(lt(t.tokenUsageDailyRollups.date, rollupCutoff));

  await getDb().delete(t.tokenUsageLogs).where(lt(t.tokenUsageLogs.timestamp, detailCutoff));
  await getDb()
    .delete(t.tokenUsageDailyRollups)
    .where(lt(t.tokenUsageDailyRollups.date, rollupCutoff));

  return { prunedLogs: Number(logCount?.total ?? 0), prunedRollups: Number(rollupCount?.total ?? 0) };
}

/**
 * Run one full maintenance pass: flush pending writes, roll up, then prune.
 */
export async function runMaintenance(): Promise<void> {
  try {
    await tokenMetricsLogger.flush();
    const rolled = await runRollup();
    const { prunedLogs, prunedRollups } = await runPruning();

    if (rolled || prunedLogs || prunedRollups) {
      console.log(
        `[Metrics] Maintenance: rolled up ${rolled} rows, pruned ${prunedLogs} logs / ${prunedRollups} rollups`,
      );
    }
  } catch (error) {
    console.error('[Metrics] Maintenance pass failed:', error);
  }
}

/**
 * Start the recurring maintenance loop. Runs once shortly after boot so a
 * long-lived process is not the only thing keeping rollups fresh.
 */
export function startMetricsMaintenance(): void {
  if (timer) {
    return;
  }

  const initial = setTimeout(() => void runMaintenance(), 30_000);
  initial.unref?.();

  timer = setInterval(() => void runMaintenance(), MAINTENANCE_INTERVAL_MS);
  timer.unref?.();
}
