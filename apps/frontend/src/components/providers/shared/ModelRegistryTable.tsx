import { useState } from 'react';
import { ModelSpec } from '@/lib/types';
import { CopyButton, ModelIdChip } from '@/components/shared/CopyButton';

interface Props {
  models: ModelSpec[];
  /** Prefix that clients must send — model IDs are shown as `providerId:modelId`. */
  providerId: string;
}

export function ModelRegistryTable({ models, providerId }: Props) {
  const [search, setSearch] = useState('');
  const [poolFilter, setPoolFilter] = useState<'ALL' | 'cli' | 'sandbox'>('ALL');

  const filtered = models.filter((m) => {
    const text = `${providerId}:${m.modelId}`.toLowerCase() + (m.displayName || '').toLowerCase() + (m.upstreamModelId || '').toLowerCase();
    if (search && !text.includes(search.toLowerCase())) return false;
    if (poolFilter !== 'ALL' && m.pool !== poolFilter) return false;
    return true;
  });

  const allIds = filtered.map((m) => `${providerId}:${m.modelId}`).join('\n');

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 bg-base-200 p-3 rounded-xl border border-base-300">
        <input
          type="text"
          placeholder={`Search models... (call them as ${providerId}:model)`}
          className="input input-sm input-bordered w-full sm:max-w-sm bg-base-100 text-base-content"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        <div className="flex items-center gap-3 flex-wrap">
          <CopyButton
            value={allIds}
            label={`Copy ${filtered.length} ID${filtered.length === 1 ? '' : 's'}`}
            className="border border-base-300"
            title="Copy every visible model ID, one per line"
          />

          <div className="flex items-center gap-2">
            <span className="text-xs text-base-content/50 font-medium">Pool:</span>
            <div className="join border border-base-300 rounded-lg">
              {(['ALL', 'cli', 'sandbox'] as const).map((p) => (
                <button
                  key={p}
                  className={`join-item btn btn-xs px-3 ${poolFilter === p ? 'btn-primary' : 'btn-ghost text-base-content/65'}`}
                  onClick={() => setPoolFilter(p)}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="block lg:hidden space-y-3">
        {filtered.length === 0 ? (
          <div className="text-center py-8 text-base-content/30 text-sm">No models found</div>
        ) : (
          filtered.map((m) => (
            <div key={m.modelId} className="card bg-base-200 border border-base-300 shadow-sm p-4 space-y-3">
              <div className="flex justify-between items-start gap-2">
                <div className="min-w-0">
                  <h4 className="font-bold text-sm text-base-content truncate">{m.displayName || m.modelId}</h4>
                  <div className="mt-0.5">
                    <ModelIdChip providerId={providerId} modelId={m.modelId} />
                  </div>
                </div>
                <span className={`badge ${m.pool === 'cli' ? 'badge-secondary' : 'badge-accent'} badge-sm font-semibold uppercase`}>
                  {m.pool}
                </span>
              </div>
              
              <div className="grid grid-cols-2 gap-2 text-xs text-base-content/70">
                <div>
                  <span className="text-base-content/40 block">Max Output</span>
                  <span className="font-semibold">{m.maxOutputTokens.toLocaleString()} tokens</span>
                </div>
                <div>
                  <span className="text-base-content/40 block">Timeout</span>
                  <span className="font-semibold">{m.timeoutMs ? `${m.timeoutMs / 1000}s` : '60s'}</span>
                </div>
                {m.isThinking && (
                  <div className="col-span-2 bg-primary/10 border border-primary/20 p-2 rounded-lg mt-1 text-base-content">
                    <span className="text-primary text-[10px] font-bold block uppercase tracking-wider">Extended Thinking Active</span>
                    <div className="flex gap-4 mt-0.5 text-[10px]">
                      <span>Mode: <strong className="capitalize">{m.thinkingMode || 'level'}</strong></span>
                      {m.thinkingBudget !== undefined && <span>Budget: <strong>{m.thinkingBudget}</strong></span>}
                      {m.thinkingLevel !== undefined && <span>Level: <strong className="capitalize">{m.thinkingLevel}</strong></span>}
                    </div>
                  </div>
                )}
                {m.upstreamModelId && (
                  <div className="col-span-2">
                    <span className="text-base-content/40 text-[10px] block">Upstream Target</span>
                    <span className="font-mono text-[10px] select-all">{m.upstreamModelId}</span>
                  </div>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="hidden lg:block overflow-x-auto border border-base-300 rounded-xl bg-base-100 shadow-sm">
        <table className="table table-sm w-full text-base-content">
          <thead>
            <tr className="border-b border-base-300 text-base-content/50">
              <th>Model ID (send this as `model`)</th>
              <th>Display Name</th>
              <th>Pool</th>
              <th>Max Output</th>
              <th>Timeout</th>
              <th>Thinking</th>
              <th>Upstream Model</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={7} className="text-center py-8 text-base-content/30">No models found</td>
              </tr>
            ) : (
              filtered.map((m) => (
                <tr key={m.modelId} className="hover:bg-base-200/30 transition-colors border-b border-base-300/40">
                  <td>
                    <ModelIdChip providerId={providerId} modelId={m.modelId} />
                  </td>
                  <td>{m.displayName || <span className="text-base-content/35 italic">Same as ID</span>}</td>
                  <td>
                    <span className={`badge ${m.pool === 'cli' ? 'badge-secondary' : 'badge-accent'} badge-sm font-semibold uppercase`}>
                      {m.pool}
                    </span>
                  </td>
                  <td className="font-mono">{m.maxOutputTokens.toLocaleString()}</td>
                  <td className="font-mono">{m.timeoutMs ? `${m.timeoutMs / 1000}s` : '60s'}</td>
                  <td>
                    {m.isThinking ? (
                      <span className="badge badge-primary badge-sm font-semibold whitespace-nowrap">
                        Yes ({m.thinkingMode === 'level' ? m.thinkingLevel : `${m.thinkingBudget} budget`})
                      </span>
                    ) : (
                      <span className="text-base-content/30 italic">No</span>
                    )}
                  </td>
                  <td className="font-mono text-xs text-base-content/65 select-all">
                    {m.upstreamModelId || <span className="text-base-content/30 italic">None</span>}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
