import React, { useState } from 'react';
import { Account } from '@/lib/types';
import { HealthBadge } from '@/components/shared/HealthBadge';
import { AccountDetail } from '@/components/providers/shared/AccountDetail';

interface Props {
  account: Account;
  onCooldown: (email: string) => void;
  /**
   * Re-run project discovery. Optional, because it is a Google concept: Antigravity has a
   * cloudaicompanion project to look up and Claude Code has nothing of the kind, so the button is
   * absent there rather than present and answering 400.
   */
  onRediscover?: (email: string) => void;
  onReset: (email: string) => void;
  onDelete: (email: string) => void;
}

export function AccountCard({
  account,
  onCooldown,
  onRediscover,
  onReset,
  onDelete,
}: Props) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="card bg-base-200 border border-base-300 shadow-sm overflow-hidden">
      <div className="card-body p-4 space-y-3">
        <div className="flex justify-between items-start gap-2">
          <div className="min-w-0 flex-1">
            <h4 className="font-semibold text-sm text-base-content truncate select-all">
              {account.email}
            </h4>
            <span className="text-[10px] font-mono text-base-content/40 select-all block mt-0.5">
              {account.projectId || 'No Project ID'}
            </span>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <HealthBadge score={account.healthScore} />
            
            <div className="dropdown dropdown-end">
              <button tabIndex={0} role="button" className="btn btn-ghost btn-xs px-1 text-base-content">
                ⋮
              </button>
              <ul tabIndex={0} className="dropdown-content menu p-2 shadow-2xl bg-base-100 border border-base-300 rounded-box w-52 z-30 text-xs text-base-content">
                <li>
                  <button onClick={() => onRediscover?.(account.email)}>
                    🔄 Rediscover Project
                  </button>
                </li>
                <li>
                  <button onClick={() => onCooldown(account.email)}>
                    ❄️ Trigger Cooldown (1h)
                  </button>
                </li>
                <li>
                  <button onClick={() => onReset(account.email)}>
                    🧹 Reset State
                  </button>
                </li>
                <li className="border-t border-base-300 mt-1 pt-1">
                  <button className="text-error" onClick={() => onDelete(account.email)}>
                    🛑 Delete Account
                  </button>
                </li>
              </ul>
            </div>
          </div>
        </div>

        <div className="flex justify-between items-center pt-1 border-t border-base-300/60">
          <span className="text-[10px] text-base-content/50 font-medium">
            Used: {account.lastUsed > 0 ? new Date(account.lastUsed).toLocaleTimeString() : 'Never'}
          </span>
          <button
            className="btn btn-ghost btn-xs text-primary font-semibold"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? 'Hide Info ▲' : 'Show Info ▼'}
          </button>
        </div>

        {expanded && (
          <div className="pt-2 border-t border-base-300/40">
            <AccountDetail account={account} />
          </div>
        )}
      </div>
    </div>
  );
}
