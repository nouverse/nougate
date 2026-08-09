import { getProxyConfig } from '@/config/manager';

/**
 * How long each metrics table is kept.
 *
 * One source of truth on purpose. The write side prunes with these numbers and
 * the read side picks its table with them, so a config change has to move both
 * together — otherwise raising `detailRetentionDays` keeps the extra rows but
 * never reads them, and the dashboard reports per-request detail as unavailable
 * for data it is sitting on.
 */
export const DEFAULT_DETAIL_RETENTION_DAYS = 14;
export const DEFAULT_ROLLUP_RETENTION_DAYS = 90;

export interface RetentionWindow {
  /** Days of per-request rows in `token_usage_logs`. */
  detail: number;
  /** Days of daily aggregates in `token_usage_daily_rollups`. */
  rollup: number;
}

/**
 * Read the configured retention, falling back to the defaults when config is
 * not loaded (scripts and tests).
 */
export function retentionDays(): RetentionWindow {
  try {
    const metrics = getProxyConfig().metrics;
    return {
      detail: metrics?.detailRetentionDays ?? DEFAULT_DETAIL_RETENTION_DAYS,
      rollup: metrics?.rollupRetentionDays ?? DEFAULT_ROLLUP_RETENTION_DAYS,
    };
  } catch {
    return {
      detail: DEFAULT_DETAIL_RETENTION_DAYS,
      rollup: DEFAULT_ROLLUP_RETENTION_DAYS,
    };
  }
}
