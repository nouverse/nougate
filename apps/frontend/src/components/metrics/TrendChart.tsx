import { useMemo, useState } from 'react';
import { UsagePoint } from '@/lib/types';
import { formatCost, formatPeriod, formatTokens } from '@/lib/format';

interface Props {
  data: UsagePoint[];
  /** Which measure the two series describe. Both share one y-axis. */
  metric: 'cost' | 'tokens';
}

const WIDTH = 800;
const HEIGHT = 240;
const PADDING = { top: 16, right: 16, bottom: 28, left: 52 };

const PLOT_WIDTH = WIDTH - PADDING.left - PADDING.right;
const PLOT_HEIGHT = HEIGHT - PADDING.top - PADDING.bottom;

/**
 * Nearest bucket index for a pointer, from the transform the browser actually
 * applied to the viewBox.
 *
 * The old version divided by the element's width, which is only the same thing
 * when the element box happens to match the viewBox. It does not: the SVG has a
 * fixed height and `preserveAspectRatio` letterboxes it inside a much wider card,
 * so every reading was offset — far enough that the first and last buckets sat
 * outside the element and could not be hovered at all.
 *
 * A viewBox transform is scale + translate only, so inverting it is `(x - e) / a`.
 * Exported for the test; the component passes `svg.getScreenCTM()`.
 */
export function indexAtScreenX(
  ctm: { a: number; e: number } | null,
  clientX: number,
  count: number,
): number | null {
  if (!ctm || ctm.a === 0) {
    return null;
  }
  if (count <= 1) {
    return 0;
  }
  const userX = (clientX - ctm.e) / ctm.a;
  const ratio = (userX - PADDING.left) / PLOT_WIDTH;
  return Math.min(Math.max(Math.round(ratio * (count - 1)), 0), count - 1);
}

interface Series {
  key: string;
  label: string;
  color: string;
  /** Dashed stroke keeps the two series separable without relying on colour. */
  dashed: boolean;
  values: number[];
}

/**
 * Spend and savings over time.
 *
 * Both series are the same measure on one scale, so they share a single y-axis
 * — the chart never mixes cost and token counts on two axes.
 */
export function TrendChart({ data, metric }: Props) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const series: Series[] = useMemo(() => {
    if (metric === 'cost') {
      return [
        {
          key: 'spend',
          label: 'Spend',
          color: 'var(--color-chart-1)',
          dashed: false,
          values: data.map((point) => point.totalCost ?? 0),
        },
        {
          key: 'saved',
          label: 'Saved by compression',
          color: 'var(--color-chart-2)',
          dashed: true,
          values: data.map((point) => point.costSaved ?? 0),
        },
      ];
    }

    return [
      {
        key: 'used',
        label: 'Tokens used',
        color: 'var(--color-chart-1)',
        dashed: false,
        values: data.map((point) => point.totalTokens ?? 0),
      },
      {
        key: 'saved',
        label: 'Tokens saved',
        color: 'var(--color-chart-2)',
        dashed: true,
        values: data.map((point) => point.tokensSaved ?? 0),
      },
    ];
  }, [data, metric]);

  const maxValue = useMemo(() => {
    const all = series.flatMap((entry) => entry.values);
    return Math.max(...all, metric === 'cost' ? 0.01 : 1);
  }, [series, metric]);

  const format = metric === 'cost' ? formatCost : formatTokens;

  if (data.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-[240px] gap-2 text-base-content/40">
        <span className="text-sm font-semibold">No usage recorded yet</span>
        <span className="text-xs">Send a request through the gateway and it will appear here.</span>
      </div>
    );
  }

  const xFor = (index: number) =>
    data.length === 1
      ? PADDING.left + PLOT_WIDTH / 2
      : PADDING.left + (index / (data.length - 1)) * PLOT_WIDTH;

  const yFor = (value: number) =>
    PADDING.top + PLOT_HEIGHT - (value / maxValue) * PLOT_HEIGHT;

  const linePath = (values: number[]) =>
    values.map((value, index) => `${index === 0 ? 'M' : 'L'}${xFor(index)},${yFor(value)}`).join(' ');

  const areaPath = (values: number[]) =>
    `${linePath(values)} L${xFor(values.length - 1)},${PADDING.top + PLOT_HEIGHT} L${xFor(0)},${
      PADDING.top + PLOT_HEIGHT
    } Z`;

  // Four gridlines is enough context without competing with the data.
  const gridLines = [0, 0.25, 0.5, 0.75, 1];

  // Keep axis labels from colliding on dense windows.
  const labelStep = Math.max(1, Math.ceil(data.length / 8));

  const active = hoverIndex !== null ? data[hoverIndex] : null;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-4 flex-wrap">
        {series.map((entry) => (
          <div key={entry.key} className="flex items-center gap-2">
            <svg width="18" height="10" aria-hidden="true">
              <line
                x1="0"
                y1="5"
                x2="18"
                y2="5"
                stroke={entry.color}
                strokeWidth="2"
                strokeDasharray={entry.dashed ? '4 3' : undefined}
              />
            </svg>
            <span className="text-[11px] font-semibold text-base-content/70">{entry.label}</span>
          </div>
        ))}
      </div>

      <div className="relative w-full overflow-x-auto">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="w-full h-[240px]"
          role="img"
          aria-label={`${metric === 'cost' ? 'Spend' : 'Token'} trend over the selected window`}
          onMouseLeave={() => setHoverIndex(null)}
          onMouseMove={(event) =>
            setHoverIndex(
              indexAtScreenX(event.currentTarget.getScreenCTM(), event.clientX, data.length),
            )
          }
        >
          <defs>
            {series.map((entry) => (
              <linearGradient key={entry.key} id={`grad-${entry.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={entry.color} stopOpacity="0.22" />
                <stop offset="100%" stopColor={entry.color} stopOpacity="0" />
              </linearGradient>
            ))}
          </defs>

          {gridLines.map((ratio) => {
            const y = PADDING.top + PLOT_HEIGHT * ratio;
            return (
              <g key={ratio}>
                <line
                  x1={PADDING.left}
                  y1={y}
                  x2={WIDTH - PADDING.right}
                  y2={y}
                  stroke="currentColor"
                  strokeWidth="1"
                  className="text-base-content/10"
                />
                <text
                  x={PADDING.left - 8}
                  y={y + 3}
                  textAnchor="end"
                  className="fill-current text-base-content/40"
                  fontSize="9"
                >
                  {format(maxValue * (1 - ratio))}
                </text>
              </g>
            );
          })}

          {series.map((entry) => (
            <g key={entry.key}>
              <path d={areaPath(entry.values)} fill={`url(#grad-${entry.key})`} />
              <path
                d={linePath(entry.values)}
                fill="none"
                stroke={entry.color}
                strokeWidth="2"
                strokeLinejoin="round"
                strokeLinecap="round"
                strokeDasharray={entry.dashed ? '5 4' : undefined}
              />
            </g>
          ))}

          {data.map((point, index) =>
            index % labelStep === 0 ? (
              <text
                key={point.period}
                x={xFor(index)}
                y={HEIGHT - 8}
                textAnchor="middle"
                className="fill-current text-base-content/40"
                fontSize="9"
              >
                {formatPeriod(point.period)}
              </text>
            ) : null,
          )}

          {hoverIndex !== null && (
            <g>
              <line
                x1={xFor(hoverIndex)}
                y1={PADDING.top}
                x2={xFor(hoverIndex)}
                y2={PADDING.top + PLOT_HEIGHT}
                stroke="currentColor"
                strokeWidth="1"
                className="text-base-content/30"
              />
              {series.map((entry) => (
                <circle
                  key={entry.key}
                  cx={xFor(hoverIndex)}
                  cy={yFor(entry.values[hoverIndex])}
                  r="4"
                  fill={entry.color}
                  stroke="var(--color-base-200)"
                  strokeWidth="2"
                />
              ))}
            </g>
          )}
        </svg>

        {active && (
          <div className="absolute top-2 right-2 bg-base-100 border border-base-300 rounded-lg shadow-lg px-3 py-2 text-[11px] pointer-events-none">
            <div className="font-bold text-base-content mb-1">{formatPeriod(active.period)}</div>
            {series.map((entry) => (
              <div key={entry.key} className="flex items-center justify-between gap-4">
                <span className="flex items-center gap-1.5 text-base-content/60">
                  <span
                    className="inline-block w-2 h-2 rounded-full"
                    style={{ background: entry.color }}
                  />
                  {entry.label}
                </span>
                <span className="font-mono font-bold text-base-content">
                  {format(entry.values[hoverIndex!])}
                </span>
              </div>
            ))}
            <div className="flex items-center justify-between gap-4 mt-1 pt-1 border-t border-base-300">
              <span className="text-base-content/60">Requests</span>
              <span className="font-mono font-bold text-base-content">{active.requests}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
