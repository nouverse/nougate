/**
 * Shared number formatting for the metrics dashboard, so a cost reads the same
 * way in a stat tile, a bar list and a table.
 */

export function formatCost(value: number): string {
  if (!value) {
    return '$0.00';
  }
  if (value < 0.01) {
    return `$${value.toFixed(4)}`;
  }
  if (value < 1000) {
    return `$${value.toFixed(2)}`;
  }
  return `$${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

export function formatTokens(value: number): string {
  if (!value) {
    return '0';
  }
  if (value >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(2)}B`;
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(2)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`;
  }
  return value.toLocaleString('en-US');
}

export function formatCount(value: number): string {
  return (value ?? 0).toLocaleString('en-US');
}

export function formatPercent(value: number): string {
  return `${(value ?? 0).toFixed(1)}%`;
}

export function formatDuration(ms: number): string {
  if (!ms) {
    return '—';
  }
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

export function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleString();
}

const pad = (value: number): string => String(value).padStart(2, '0');

/**
 * Hourly bucket keys are UTC — the backend buckets with `at time zone 'UTC'` —
 * so parse the instant rather than reading the digits, which are seven hours off
 * in Jakarta. Daily keys have no instant: a day bucket is a UTC calendar day, and
 * shifting it into local time would relabel it as the wrong date.
 */
function hourBucketDate(period: string): Date | null {
  if (!period.includes('T')) {
    return null;
  }
  const date = new Date(`${period}:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Turn a bucket key from the API ("2026-08-08" or "2026-08-08T14:00") into a
 * short axis label, in the viewer's timezone so it agrees with `formatTimestamp`.
 */
export function formatPeriod(period: string): string {
  const instant = hourBucketDate(period);
  if (instant) {
    // Minutes, not a hard ":00" — not every zone is a whole hour off UTC.
    return `${pad(instant.getHours())}:${pad(instant.getMinutes())}`;
  }
  const [, month, day] = period.split('-');
  return month && day ? `${day}/${month}` : period;
}

/**
 * The same bucket with its date, for the table beside the chart.
 */
export function formatPeriodLong(period: string): string {
  const instant = hourBucketDate(period);
  if (!instant) {
    return period;
  }
  return `${instant.getFullYear()}-${pad(instant.getMonth() + 1)}-${pad(
    instant.getDate(),
  )} ${pad(instant.getHours())}:${pad(instant.getMinutes())}`;
}
