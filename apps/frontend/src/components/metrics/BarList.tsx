interface BarItem {
  label: string;
  value: number;
  /** Right-aligned formatted figure, e.g. a cost. */
  secondary?: string;
}

interface Props {
  items: BarItem[];
  format: (value: number) => string;
  emptyMessage?: string;
}

/**
 * Ranked magnitude comparison. One series, so no legend — every bar is direct
 * labelled and the bars share a single hue rather than being coloured by rank.
 */
export function BarList({ items, format, emptyMessage = 'No data yet' }: Props) {
  if (items.length === 0) {
    return (
      <div className="py-8 text-center text-xs text-base-content/40 font-medium">{emptyMessage}</div>
    );
  }

  const max = Math.max(...items.map((item) => item.value), 1);

  return (
    <div className="space-y-2.5">
      {items.map((item) => (
        <div key={item.label} className="space-y-1">
          <div className="flex items-center justify-between gap-3 text-[11px]">
            <span className="font-semibold text-base-content truncate" title={item.label}>
              {item.label}
            </span>
            <span className="font-mono font-bold text-base-content/70 shrink-0">
              {format(item.value)}
              {item.secondary && (
                <span className="text-base-content/40 font-normal ml-2">{item.secondary}</span>
              )}
            </span>
          </div>
          <div className="h-1.5 w-full bg-base-300 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.max((item.value / max) * 100, 1.5)}%`,
                background: 'var(--color-chart-1)',
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
