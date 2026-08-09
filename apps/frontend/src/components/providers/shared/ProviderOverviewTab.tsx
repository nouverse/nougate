import { Activity, Coins, Cpu, Hash, Users } from 'lucide-react';

import { BarList } from '@/components/metrics/BarList';
import { StatTile } from '@/components/metrics/StatTile';
import { useTokenUsage } from '@/hooks/useQueries';
import { formatCost, formatCount, formatTimestamp, formatTokens } from '@/lib/format';
import type { Account, ModelSpec } from '@/lib/types';

interface Props {
  providerId: string;
  accounts: Account[];
  models: ModelSpec[];
}

/**
 * The overview every provider can answer, whatever it is underneath: how much
 * traffic it carried, what that cost, and whether its accounts are healthy.
 *
 * Provider-specific panels (Antigravity's quotas, for one) live in their own
 * tabs — putting them here made the overview mostly empty for every provider
 * that does not report them.
 */
export function ProviderOverviewTab({ providerId, accounts, models }: Props) {
  const { data, isLoading } = useTokenUsage('7d', 'all', providerId, 'all');

  const now = Date.now();
  const cooling = accounts.filter((account) => {
    const cooldown = account.cooldowns?.default;
    return typeof cooldown === 'number' && cooldown > now;
  }).length;
  const healthy = accounts.length - cooling;

  const summary = data?.summary;
  const modelStats = data?.modelStats ?? [];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <StatTile
          label="Accounts"
          value={formatCount(healthy)}
          hint={
            accounts.length === 0
              ? 'None configured — requests will fail'
              : cooling > 0
                ? `${cooling} in cooldown of ${accounts.length}`
                : `all ${accounts.length} available`
          }
          icon={<Users className="w-3.5 h-3.5" />}
        />
        <StatTile
          label="Models"
          value={formatCount(models.length)}
          hint={`callable as ${providerId}:model`}
          icon={<Cpu className="w-3.5 h-3.5" />}
        />
        <StatTile
          label="Requests"
          value={summary ? formatCount(summary.requests) : '—'}
          hint="last 7 days"
          icon={<Activity className="w-3.5 h-3.5" />}
        />
        <StatTile
          label="Tokens"
          value={summary ? formatTokens(summary.totalTokens) : '—'}
          hint="last 7 days"
          icon={<Hash className="w-3.5 h-3.5" />}
        />
        <StatTile
          label="Cost"
          value={summary ? formatCost(summary.totalCost) : '—'}
          hint="last 7 days"
          icon={<Coins className="w-3.5 h-3.5" />}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="card bg-base-200 border border-base-300 shadow-sm lg:col-span-2 min-w-0">
          <div className="card-body p-5 space-y-4">
            <h3 className="card-title text-sm font-bold tracking-wide">TOP MODELS BY TOKENS (7D)</h3>
            {isLoading ? (
              <div className="flex items-center gap-2 text-xs text-base-content/50 py-6">
                <span className="loading loading-spinner loading-xs" />
                Loading usage…
              </div>
            ) : (
              <BarList
                items={modelStats.slice(0, 8).map((model) => ({
                  label: model.fullModelName,
                  value: model.totalTokens,
                  // Tokens but no cost means no rate is known for this model —
                  // say so rather than letting it read as genuinely free.
                  secondary:
                    model.totalCost === 0 && model.totalTokens > 0
                      ? 'unpriced'
                      : formatCost(model.totalCost),
                }))}
                format={formatTokens}
                emptyMessage="No traffic through this provider in the last 7 days"
              />
            )}
          </div>
        </div>

        <div className="card bg-base-200 border border-base-300 shadow-sm min-w-0">
          <div className="card-body p-5 space-y-3">
            <h3 className="card-title text-sm font-bold tracking-wide">ACCOUNT HEALTH</h3>
            {accounts.length === 0 ? (
              <p className="text-xs text-base-content/40 py-4">
                No accounts yet. Add one on the Accounts tab before calling this provider.
              </p>
            ) : (
              <ul className="space-y-3">
                {accounts.map((account) => {
                  const cooldown = account.cooldowns?.default;
                  const inCooldown = typeof cooldown === 'number' && cooldown > now;
                  return (
                    <li key={account.id} className="space-y-1 min-w-0">
                      <div className="flex items-center justify-between gap-2 text-[11px]">
                        <span className="font-semibold truncate" title={account.email}>
                          {account.email}
                        </span>
                        <span className="font-mono font-bold text-base-content/70 shrink-0">
                          {account.healthScore}
                        </span>
                      </div>
                      <progress
                        className={`progress w-full h-1.5 ${inCooldown ? 'progress-warning' : 'progress-primary'}`}
                        value={Math.max(0, Math.min(100, account.healthScore))}
                        max={100}
                      />
                      <div className="flex items-center justify-between gap-2 text-[10px] text-base-content/40">
                        <span>
                          {account.lastUsed ? formatTimestamp(account.lastUsed) : 'never used'}
                        </span>
                        {inCooldown && (
                          <span className="badge badge-xs badge-warning font-bold">cooldown</span>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
