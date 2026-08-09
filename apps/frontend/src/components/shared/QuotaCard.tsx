import { Infinity as InfinityIcon } from 'lucide-react';

import type { ProviderQuota } from '@/lib/types';

interface Props {
  quota: ProviderQuota;
}

/**
 * One usage limit, rendered from the normalised `IProviderQuota` shape.
 *
 * It takes the contract object whole rather than a spread of props, so there is
 * no per-provider mapping layer that could quietly disagree with the backend.
 * Nothing here knows which provider produced the figures, what they count, or
 * how the window works — labels and units come from the provider, and the only
 * judgement made locally is which colour reads as "running low".
 */
export function QuotaCard({ quota }: Props) {
  const { label, remainingFraction, unlimited = false, used, limit, unit, resetIn } = quota;
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

  const suffix = unit ? ` ${unit}` : '';

  // On an unlimited plan a percentage is meaningless — showing a full bar would
  // imply a cap that is 100% free. The consumption figure is the real content.
  const footer = unlimited
    ? used && used !== '0'
      ? `${used}${suffix} used this cycle`
      : 'No usage recorded this cycle'
    : used && limit
      ? `${used} / ${limit}${suffix}`
      : used
        ? `${used}${suffix} used`
        : null;

  return (
    <div className="card bg-base-200 border border-base-300 shadow-sm hover:shadow-md hover:border-primary/20 transition-all duration-300 select-none h-full">
      <div className="card-body p-4 flex flex-col justify-between gap-3">
        <div className="flex items-start justify-between gap-2">
          <h4 className="font-semibold text-sm text-base-content/90 line-clamp-2 leading-snug">
            {label}
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
