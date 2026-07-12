import React from 'react';
import { Account } from '@/lib/types';

interface Props {
  account: Account;
}

export function AccountDetail({ account }: Props) {
  const hasCapabilities = account.capabilities && Object.keys(account.capabilities).length > 0;
  const hasCooldowns = account.cooldowns && Object.keys(account.cooldowns).length > 0;
  const hasModelScores = account.modelScores && Object.keys(account.modelScores).length > 0;

  return (
    <div className="p-4 bg-base-300/40 rounded-lg space-y-4 text-xs">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div>
          <span className="block text-base-content/40 font-semibold mb-1">PROJECT ID</span>
          <span className="font-mono text-base-content/80 select-all">{account.projectId || 'None'}</span>
        </div>
        <div>
          <span className="block text-base-content/40 font-semibold mb-1">TOKEN USAGE</span>
          <span className="font-mono text-base-content/80">{(account.tokenUsage || 0).toLocaleString()}</span>
        </div>
        <div>
          <span className="block text-base-content/40 font-semibold mb-1">CONSECUTIVE FAILURES</span>
          <span className="font-mono text-base-content/80 text-error">{account.consecutiveFailures || 0}</span>
        </div>
        <div>
          <span className="block text-base-content/40 font-semibold mb-1">LAST USED</span>
          <span className="font-mono text-base-content/80">
            {account.lastUsed > 0 ? new Date(account.lastUsed).toLocaleTimeString() : 'Never'}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 pt-2 border-t border-base-300">
        <div>
          <span className="block text-base-content/40 font-semibold mb-2">CAPABILITIES</span>
          {hasCapabilities ? (
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(account.capabilities || {}).map(([key, val]) => (
                <span
                  key={key}
                  className={`badge badge-sm font-mono border-0 ${val ? 'badge-primary text-primary-content' : 'badge-neutral text-base-content/50'}`}
                >
                  {key}
                </span>
              ))}
            </div>
          ) : (
            <span className="text-base-content/30 italic">No capabilities set</span>
          )}
        </div>

        <div>
          <span className="block text-base-content/40 font-semibold mb-2">ACTIVE COOLDOWNS</span>
          {hasCooldowns ? (
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(account.cooldowns || {}).map(([pool, until]) => (
                <span key={pool} className="badge badge-sm badge-warning font-mono">
                  {pool}: {typeof until === 'number' ? new Date(until).toLocaleTimeString() : String(until)}
                </span>
              ))}
            </div>
          ) : (
            <span className="text-base-content/30 italic">No active cooldowns</span>
          )}
        </div>

        <div>
          <span className="block text-base-content/40 font-semibold mb-2">MODEL FAILURE SCORES</span>
          {hasModelScores ? (
            <div className="space-y-1 font-mono">
              {Object.entries(account.modelScores || {}).map(([model, score]) => (
                <div key={model} className="flex justify-between items-center text-[10px] text-base-content/70">
                  <span className="truncate max-w-[150px]">{model}</span>
                  <span className={score > 0 ? 'text-error font-semibold' : 'text-success'}>{score}</span>
                </div>
              ))}
            </div>
          ) : (
            <span className="text-base-content/30 italic">No model failure logs</span>
          )}
        </div>
      </div>
    </div>
  );
}
