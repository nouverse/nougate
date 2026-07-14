import React, { useState } from 'react';
import { Account } from '@/lib/types';
import { HealthBadge } from '@/components/shared/HealthBadge';
import { AccountDetail } from './AccountDetail';

interface Props {
  accounts: Account[];
  onCooldown: (id: string) => void;
  onReset: (id: string) => void;
  onDelete: (id: string) => void;
}

export function AccountsTable({
  accounts,
  onCooldown,
  onReset,
  onDelete,
}: Props) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const toggleRow = (id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  };

  return (
    <div className="overflow-x-auto border border-base-300 rounded-xl shadow-sm bg-base-100">
      <table className="table table-sm w-full text-base-content">
        <thead>
          <tr className="border-b border-base-300 text-base-content/50">
            <th className="w-8"></th>
            <th>GitHub Username</th>
            <th>Health</th>
            <th>Last Active</th>
            <th className="text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {accounts.map((acc) => {
            const isExpanded = expandedId === acc.id;
            return (
              <React.Fragment key={acc.id}>
                <tr className="hover:bg-base-200/40 transition-colors border-b border-base-300/40">
                  <td>
                    <button
                      className="btn btn-ghost btn-xs font-mono text-base-content"
                      onClick={() => toggleRow(acc.id)}
                    >
                      {isExpanded ? '▼' : '▶'}
                    </button>
                  </td>
                  <td className="font-semibold select-all">
                    {acc.email}
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
                        title="Trigger 1h Cooldown"
                        className="btn btn-ghost btn-xs text-warning"
                        onClick={() => onCooldown(acc.id)}
                      >
                        ❄️ Cooldown
                      </button>
                      <button
                        title="Reset Account state"
                        className="btn btn-ghost btn-xs text-info"
                        onClick={() => onReset(acc.id)}
                      >
                        🧹 Reset
                      </button>
                      <button
                        title="Delete Account"
                        className="btn btn-ghost btn-xs text-error"
                        onClick={() => onDelete(acc.id)}
                      >
                        🛑 Delete
                      </button>
                    </div>
                  </td>
                </tr>

                {isExpanded && (
                  <tr className="bg-base-200/20 border-b border-base-300/40">
                    <td colSpan={5} className="p-0">
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
