import React from 'react';

interface Props {
  groupName: string;
  quotaLeft: string;
  remainingFraction: number;
  usage: string | number;
  limit: string | number;
  resetIn: string;
}

export function QuotaCard({
  groupName,
  quotaLeft,
  remainingFraction,
  usage,
  limit,
  resetIn,
}: Props) {
  const percentage = Math.round(remainingFraction * 100);
  
  let progressColor = 'progress-success';
  let badgeColor = 'badge-success';
  if (remainingFraction < 0.2) {
    progressColor = 'progress-error';
    badgeColor = 'badge-error';
  } else if (remainingFraction < 0.6) {
    progressColor = 'progress-warning';
    badgeColor = 'badge-warning';
  }

  return (
    <div className="card bg-base-200 border border-base-300 shadow-sm hover:shadow-md hover:border-primary/20 transition-all duration-300 select-none">
      <div className="card-body p-4 flex flex-col justify-between gap-3">
        <div className="flex items-start justify-between gap-2">
          <h4 className="font-semibold text-sm text-base-content/90 line-clamp-2 leading-snug">
            {groupName}
          </h4>
          <span className={`badge ${badgeColor} badge-sm font-semibold whitespace-nowrap`}>
            {quotaLeft}
          </span>
        </div>

        <div className="space-y-1">
          <progress
            className={`progress w-full ${progressColor}`}
            value={percentage}
            max="100"
          />
          <div className="flex justify-between items-center text-[10px] text-base-content/50 font-medium">
            {usage !== 'Unknown' && limit !== 'Unknown' ? (
              <span>
                {usage} / {limit} requests
              </span>
            ) : (
              <span />
            )}
            <span>Reset: {resetIn}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
