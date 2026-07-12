import React, { useState } from 'react';
import { Account } from '@/lib/types';
import { HealthBadge } from '@/components/shared/HealthBadge';
import { AccountDetail } from '@/components/providers/antigravity/AccountDetail';

interface Props {
  accounts: Account[];
  onCooldown: (email: string) => void;
  onRediscover: (email: string) => void;
  onReset: (email: string) => void;
  onDelete: (email: string) => void;
}

export function AccountsTable({
  accounts,
  onCooldown,
  onRediscover,
  onReset,
  onDelete,
}: Props) {
  const [expandedEmail, setExpandedEmail] = useState<string | null>(null);

  const toggleRow = (email: string) => {
    setExpandedEmail((prev) => (prev === email ? null : email));
  };

  return (
    <div className="overflow-x-auto border border-base-300 rounded-xl shadow-sm bg-base-100">
      <table className="table table-sm w-full text-base-content">
        <thead>
          <tr className="border-b border-base-300 text-base-content/50">
            <th className="w-8"></th>
            <th>Email</th>
            <th>Project ID</th>
            <th>Health</th>
            <th>Last Active</th>
            <th className="text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {accounts.map((acc) => {
            const isExpanded = expandedEmail === acc.email;
            return (
              <React.Fragment key={acc.email}>
                <tr className="hover:bg-base-200/40 transition-colors border-b border-base-300/40">
                  <td>
                    <button
                      className="btn btn-ghost btn-xs font-mono text-base-content"
                      onClick={() => toggleRow(acc.email)}
                    >
                      {isExpanded ? '▼' : '▶'}
                    </button>
                  </td>
                  <td className="font-semibold select-all">
                    {acc.email}
                  </td>
                  <td className="font-mono text-base-content/65 select-all">
                    {acc.projectId || <span className="text-base-content/30 italic">None</span>}
                  </td>
                  <td>
                    <HealthBadge score={acc.healthScore} />
                  </td>
                  <td className="text-base-content/65 font-mono text-xs">
                    {acc.lastUsed > 0 ? new Date(acc.lastUsed).toLocaleTimeString() : 'Never'}
                  </td>
                  <td className="text-right">
                    <div className="flex justify-end gap-1.5">
                      <button
                        title="Rediscover Project"
                        className="btn btn-ghost btn-xs text-primary"
                        onClick={() => onRediscover(acc.email)}
                      >
                        🔄 Rediscover
                      </button>
                      <button
                        title="Trigger 1h Cooldown"
                        className="btn btn-ghost btn-xs text-warning"
                        onClick={() => onCooldown(acc.email)}
                      >
                        ❄️ Cooldown
                      </button>
                      <button
                        title="Reset Account state"
                        className="btn btn-ghost btn-xs text-info"
                        onClick={() => onReset(acc.email)}
                      >
                        🧹 Reset
                      </button>
                      <button
                        title="Delete Account"
                        className="btn btn-ghost btn-xs text-error"
                        onClick={() => onDelete(acc.email)}
                      >
                        🛑 Delete
                      </button>
                    </div>
                  </td>
                </tr>

                {isExpanded && (
                  <tr className="bg-base-200/20 border-b border-base-300/40">
                    <td colSpan={6} className="p-0">
                      <div className="p-3 border-l-2 border-primary/30">
                        <AccountDetail account={acc} />
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
