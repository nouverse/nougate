import React from 'react';
import { QuotaCard } from '../../shared/QuotaCard';

interface QuotaEntry {
  groupName: string;
  quotaLeft: string;
  remainingFraction: number;
  usage: string | number;
  limit: string | number;
  resetIn: string;
  limitName: string;
  modelIds?: string[];
}

interface Props {
  quotas: QuotaEntry[];
}

export function QuotaGrid({ quotas }: Props) {
  if (quotas.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold tracking-wider text-base-content/40 uppercase px-1">
        QUOTA AVAILABILITY
      </h3>
      <div className="flex overflow-x-auto snap-x snap-mandatory lg:grid lg:grid-cols-2 xl:grid-cols-3 lg:overflow-x-visible gap-4 pb-2 lg:pb-0">
        {quotas.map((q) => (
          <div key={q.limitName} className="w-[85vw] max-w-[320px] shrink-0 snap-center lg:w-auto lg:max-w-none">
            <QuotaCard
              groupName={q.groupName}
              quotaLeft={q.quotaLeft}
              remainingFraction={q.remainingFraction}
              usage={q.usage}
              limit={q.limit}
              resetIn={q.resetIn}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
