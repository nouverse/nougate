import { dbRun } from '@/core/db';
import { getProxyConfig } from '@/config/manager';
import { tokenMetricsLogger } from '@/core/metrics/logger';

const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000; // hourly

let timer: ReturnType<typeof setInterval> | null = null;

function retentionDays(): { detail: number; rollup: number } {
  try {
    const metrics = getProxyConfig().metrics;
    return {
      detail: metrics?.detailRetentionDays ?? 14,
      rollup: metrics?.rollupRetentionDays ?? 90,
    };
  } catch {
    return { detail: 14, rollup: 90 };
  }
}

/**
 * Fold detail rows into the daily rollup table.
 *
 * Only whole days that have already passed are rolled up, so today's numbers
 * are never double-counted between the detail table and the rollups.
 */
export function runRollup(): number {
  const todayStartMs = new Date(new Date().toISOString().slice(0, 10)).getTime();

  const result = dbRun(
    `INSERT INTO token_usage_daily_rollups (
       date, provider, model, full_model_name, client_id, api_key_id,
       total_requests, total_input_tokens, total_output_tokens, total_tokens_saved,
       total_input_cost, total_output_cost, total_cost_saved
     )
     SELECT strftime('%Y-%m-%d', timestamp / 1000, 'unixepoch') AS day,
            provider, model, full_model_name, client_id,
            COALESCE(api_key_id, '') AS key_id,
            COUNT(*), SUM(input_tokens), SUM(output_tokens), SUM(tokens_saved),
            SUM(input_cost), SUM(output_cost), SUM(cost_saved)
     FROM token_usage_logs
     WHERE timestamp < $todayStart
     GROUP BY day, provider, model, full_model_name, client_id, key_id
     ON CONFLICT (date, full_model_name, client_id, api_key_id) DO UPDATE SET
       total_requests = excluded.total_requests,
       total_input_tokens = excluded.total_input_tokens,
       total_output_tokens = excluded.total_output_tokens,
       total_tokens_saved = excluded.total_tokens_saved,
       total_input_cost = excluded.total_input_cost,
       total_output_cost = excluded.total_output_cost,
       total_cost_saved = excluded.total_cost_saved`,
    { $todayStart: todayStartMs },
  );

  return result.changes;
}

/**
 * Drop data past its retention window.
 *
 * Detail rows are pruned only after they have been rolled up, so long-range
 * charts keep working off the aggregate table.
 */
export function runPruning(): { prunedLogs: number; prunedRollups: number } {
  const { detail, rollup } = retentionDays();

  const detailCutoff = Date.now() - detail * 24 * 60 * 60 * 1000;
  const rollupCutoff = new Date(Date.now() - rollup * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  const logs = dbRun(`DELETE FROM token_usage_logs WHERE timestamp < $cutoff`, {
    $cutoff: detailCutoff,
  });
  const rollups = dbRun(`DELETE FROM token_usage_daily_rollups WHERE date < $cutoff`, {
    $cutoff: rollupCutoff,
  });

  return { prunedLogs: logs.changes, prunedRollups: rollups.changes };
}

/**
 * Run one full maintenance pass: flush pending writes, roll up, then prune.
 */
export function runMaintenance(): void {
  try {
    tokenMetricsLogger.flush();
    const rolled = runRollup();
    const { prunedLogs, prunedRollups } = runPruning();

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

  const initial = setTimeout(() => runMaintenance(), 30_000);
  initial.unref?.();

  timer = setInterval(() => runMaintenance(), MAINTENANCE_INTERVAL_MS);
  timer.unref?.();
}
