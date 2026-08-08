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

/**
 * Turn a bucket key from the API ("2026-08-08" or "2026-08-08T14:00") into a
 * short axis label.
 */
export function formatPeriod(period: string): string {
  if (period.includes('T')) {
    return `${period.split('T')[1].slice(0, 2)}:00`;
  }
  const [, month, day] = period.split('-');
  return month && day ? `${day}/${month}` : period;
}
