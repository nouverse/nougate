import { Infinity as InfinityIcon } from 'lucide-react';

interface Props {
  groupName: string;
  remainingFraction: number;
  /** No cap on this plan: the figure below is consumption, not headroom. */
  unlimited?: boolean;
  used?: string;
  limit?: string;
  /** What `used`/`limit` count, supplied by the provider. */
  unit?: string;
  resetIn?: string;
}

export function QuotaCard({
  groupName,
  remainingFraction,
  unlimited = false,
  used,
  limit,
  unit,
  resetIn,
}: Props) {
  const percentage = Math.round(remainingFraction * 100);

  let progressColor = 'progress-success';
  let badgeColor = 'badge-success';
  if (!unlimited && remainingFraction < 0.2) {
    progressColor = 'progress-error';
    badgeColor = 'badge-error';
  } else if (!unlimited && remainingFraction < 0.6) {
    progressColor = 'progress-warning';
    badgeColor = 'badge-warning';
  }

  // On an unlimited plan a percentage is meaningless — showing a full bar would
  // imply a cap that is 100% free. The consumption figure is the real content.
  const footer = unlimited
    ? used && used !== '0'
      ? `${used}${unit ? ` ${unit}` : ''} used this cycle`
      : 'No usage recorded this cycle'
    : used && limit
      ? `${used} / ${limit}${unit ? ` ${unit}` : ''}`
      : used
        ? `${used}${unit ? ` ${unit}` : ''} used`
        : null;

  return (
    <div className="card bg-base-200 border border-base-300 shadow-sm hover:shadow-md hover:border-primary/20 transition-all duration-300 select-none h-full">
      <div className="card-body p-4 flex flex-col justify-between gap-3">
        <div className="flex items-start justify-between gap-2">
          <h4 className="font-semibold text-sm text-base-content/90 line-clamp-2 leading-snug">
            {groupName}
          </h4>
          {unlimited ? (
            <span className="badge badge-ghost badge-sm font-semibold whitespace-nowrap gap-1 shrink-0">
              <InfinityIcon className="w-3 h-3" />
              Unlimited
            </span>
          ) : (
            <span className={`badge ${badgeColor} badge-sm font-semibold whitespace-nowrap shrink-0`}>
              {percentage}%
            </span>
          )}
        </div>

        <div className="space-y-1">
          {!unlimited && (
            <progress className={`progress w-full ${progressColor}`} value={percentage} max="100" />
          )}
          <div className="flex justify-between items-center gap-2 text-[10px] text-base-content/50 font-medium">
            <span className="truncate">{footer}</span>
            {resetIn && <span className="shrink-0">Reset: {resetIn}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
