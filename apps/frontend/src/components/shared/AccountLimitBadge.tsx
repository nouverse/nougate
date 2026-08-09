import { Users } from 'lucide-react';

/**
 * How many accounts a provider holds, against the deployment's ceiling.
 *
 * `limit` is null when MAX_ACCOUNT_MULTIPLEXING is unset. That is not "no
 * accounts allowed" — it is no ceiling at all, so the badge falls back to a
 * plain count rather than drawing a meter against a number nobody set.
 *
 * When the pod is full the badge turns; the backend will refuse the next add,
 * and finding that out from an error dialog after a full OAuth round trip is a
 * worse way to learn it.
 */
export function AccountLimitBadge({
  count,
  limit,
  noun = 'accounts',
}: {
  count: number;
  limit: number | null;
  noun?: string;
}) {
  const isFull = limit !== null && count >= limit;

  return (
    <div
      className={`badge badge-neutral border-0 font-semibold gap-1 py-3 px-3 ${
        isFull ? 'bg-warning/20 text-warning' : 'bg-base-300 text-base-content/75'
      }`}
      title={
        limit === null
          ? 'No account limit set (MAX_ACCOUNT_MULTIPLEXING is unset)'
          : isFull
            ? `At the MAX_ACCOUNT_MULTIPLEXING limit of ${limit}. Remove one before adding another.`
            : `${limit - count} of ${limit} slots left (MAX_ACCOUNT_MULTIPLEXING)`
      }
    >
      <Users className={`w-3.5 h-3.5 ${isFull ? '' : 'text-primary'}`} />
      {limit === null ? `${count} ${noun}` : `${count} / ${limit} ${noun}`}
    </div>
  );
}
