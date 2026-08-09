import { QuotaCard } from '@/components/shared/QuotaCard';
import { EmptyState } from '@/components/shared/EmptyState';
import type { ProviderQuota } from '@/lib/types';

interface Props {
  quotas: ProviderQuota[];
}

/**
 * Renders whatever limits a provider reported. It is deliberately ignorant of
 * which provider that is: everything here comes from the normalised
 * `IProviderQuota` shape, so a new provider that implements `getQuotas()` shows
 * up without touching this file.
 */
export function QuotaGrid({ quotas }: Props) {
  if (quotas.length === 0) {
    return (
      <EmptyState message="This provider reports quotas, but none have loaded yet. They populate once its accounts are verified and the upstream has answered." />
    );
  }

  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold tracking-wider text-base-content/40 uppercase px-1">
        QUOTA AVAILABILITY
      </h3>
      <div className="flex overflow-x-auto snap-x snap-mandatory lg:grid lg:grid-cols-2 xl:grid-cols-3 lg:overflow-x-visible gap-4 pb-2 lg:pb-0">
        {quotas.map((quota) => (
          <div
            key={quota.id}
            className="w-[85vw] max-w-[320px] shrink-0 snap-center lg:w-auto lg:max-w-none"
          >
            <QuotaCard
              groupName={quota.label}
              quotaLeft={`${Math.round(quota.remainingFraction * 100)}%`}
              remainingFraction={quota.remainingFraction}
              usage={quota.used ?? '—'}
              limit={quota.limit ?? '—'}
              resetIn={quota.resetIn ?? '—'}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
