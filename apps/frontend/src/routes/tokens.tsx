import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { useTokenUsage, useRecentUsage } from '@/hooks/useQueries';
import { Lookback } from '@/lib/types';
import { StatTile } from '@/components/metrics/StatTile';
import { CompressionBreakdown } from '@/components/metrics/CompressionBreakdown';
import { TrendChart } from '@/components/metrics/TrendChart';
import { BarList } from '@/components/metrics/BarList';
import {
  formatCost,
  formatCount,
  formatDuration,
  formatPercent,
  formatTimestamp,
  formatTokens,
} from '@/lib/format';
import { DollarSign, Scissors, Zap, Activity, Download, Table2, LineChart, KeyRound } from 'lucide-react';

export const Route = createFileRoute('/tokens')({
  component: TokensPage,
});

const LOOKBACKS: Lookback[] = ['24h', '7d', '14d', '30d', '60d', '90d'];

function TokensPage() {
  const [lookback, setLookback] = useState<Lookback>('24h');
  const [clientId, setClientId] = useState('all');
  const [provider, setProvider] = useState('all');
  const [apiKeyId, setApiKeyId] = useState('all');
  const [metric, setMetric] = useState<'cost' | 'tokens'>('cost');
  const [showTable, setShowTable] = useState(false);

  const { data, isLoading, error } = useTokenUsage(lookback, clientId, provider, apiKeyId);
  const { data: recent } = useRecentUsage(25);

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-3 text-base-content/60">
        <span className="loading loading-spinner loading-md" />
        <span className="text-sm font-medium">Loading token analytics...</span>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="alert alert-error text-xs font-semibold shadow-md">
        <span>Failed to load token metrics: {error?.message || 'Unknown error'}</span>
      </div>
    );
  }

  const { summary, usageData, modelStats, providerStats, clientStats, apiKeyStats, clients } = data;
  // The rate the saved tokens were actually valued at. Derived from the two
  // recorded totals rather than blending input and output prices, which would
  // overstate it — output is usually the dearer side.
  const savedTokenPricePer1M =
    summary.tokensSaved > 0 ? (summary.costSaved / summary.tokensSaved) * 1_000_000 : 0;
  const exportUrl =
    `/api/metrics/export?lookback=${lookback}&clientId=${encodeURIComponent(clientId)}` +
    `&provider=${encodeURIComponent(provider)}&apiKeyId=${encodeURIComponent(apiKeyId)}`;

  return (
    <div className="space-y-6 text-base-content">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-base-300 pb-4">
        <div>
          <h1 className="text-xl font-extrabold tracking-tight">Token Usage &amp; Cost</h1>
          <p className="text-xs text-base-content/50 mt-0.5">
            Estimated spend at upstream list prices, and what compression saved.
          </p>
        </div>

        <a href={exportUrl} className="btn btn-sm btn-ghost rounded-xl font-semibold self-start gap-2">
          <Download className="w-3.5 h-3.5" />
          Export CSV
        </a>
      </div>

      {/* Filters live in one row above the charts. */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="tabs tabs-box bg-base-200 p-0.5 rounded-lg">
          {LOOKBACKS.map((option) => (
            <button
              key={option}
              type="button"
              className={`tab tab-xs rounded-md ${
                lookback === option ? 'tab-active font-semibold' : 'text-base-content/60'
              }`}
              onClick={() => setLookback(option)}
            >
              {option}
            </button>
          ))}
        </div>

        <select
          className="select select-bordered select-xs bg-base-200 text-xs font-semibold"
          value={clientId}
          onChange={(event) => setClientId(event.target.value)}
        >
          <option value="all">All clients</option>
          {clients.map((client) => (
            <option key={client} value={client}>
              {client}
            </option>
          ))}
        </select>

        <select
          className="select select-bordered select-xs bg-base-200 text-xs font-semibold"
          value={provider}
          onChange={(event) => setProvider(event.target.value)}
        >
          <option value="all">All providers</option>
          {providerStats.map((entry) => (
            <option key={entry.provider} value={entry.provider}>
              {entry.provider}
            </option>
          ))}
        </select>

        <select
          className="select select-bordered select-xs bg-base-200 text-xs font-semibold"
          value={apiKeyId}
          onChange={(event) => setApiKeyId(event.target.value)}
        >
          <option value="all">All API keys</option>
          {apiKeyStats.map((entry) => (
            <option key={entry.apiKeyId} value={entry.apiKeyId}>
              {entry.name}
              {entry.revoked ? ' (revoked)' : ''}
            </option>
          ))}
        </select>

        {summary.pendingWrites > 0 && (
          <span className="text-[10px] text-base-content/40 font-mono">
            {summary.pendingWrites} write(s) buffered
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <StatTile
          label="Estimated spend"
          value={formatCost(summary.totalCost)}
          hint={`Without compression: ${formatCost(summary.originalCost)}`}
          icon={<DollarSign className="w-4 h-4" />}
        />
        <StatTile
          label="Saved by compression"
          value={formatCost(summary.costSaved)}
          hint={`${formatTokens(summary.tokensSaved)} tokens removed`}
          badge={formatPercent(summary.savingsPercent)}
          icon={<Scissors className="w-4 h-4" />}
        />
        <StatTile
          label="Tokens processed"
          value={formatTokens(summary.totalTokens)}
          hint={`${formatTokens(summary.inputTokens)} in · ${formatTokens(summary.outputTokens)} out`}
          icon={<Zap className="w-4 h-4" />}
        />
        <StatTile
          label="Requests"
          value={formatCount(summary.requests)}
          hint={`Avg latency ${formatDuration(summary.avgDurationMs)}`}
          icon={<Activity className="w-4 h-4" />}
        />
      </div>

      <CompressionBreakdown
        breakdown={data.compression}
        inputPricePer1M={savedTokenPricePer1M}
      />

      <div className="card bg-base-200 border border-base-300 shadow-sm">
        <div className="card-body p-5 space-y-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <h3 className="card-title text-sm font-bold tracking-wide flex items-center gap-2">
              <LineChart className="w-4 h-4 text-primary" />
              {metric === 'cost' ? 'SPEND & SAVINGS TREND' : 'TOKEN TREND'}
            </h3>

            <div className="flex items-center gap-2">
              <div className="tabs tabs-box bg-base-100 p-0.5 rounded-lg">
                <button
                  type="button"
                  className={`tab tab-xs rounded-md ${metric === 'cost' ? 'tab-active font-semibold' : 'text-base-content/60'}`}
                  onClick={() => setMetric('cost')}
                >
                  Cost
                </button>
                <button
                  type="button"
                  className={`tab tab-xs rounded-md ${metric === 'tokens' ? 'tab-active font-semibold' : 'text-base-content/60'}`}
                  onClick={() => setMetric('tokens')}
                >
                  Tokens
                </button>
              </div>

              <button
                type="button"
                className="btn btn-ghost btn-xs gap-1.5"
                onClick={() => setShowTable(!showTable)}
                title="Toggle the accessible table view of this chart"
              >
                <Table2 className="w-3.5 h-3.5" />
                {showTable ? 'Hide table' : 'Table'}
              </button>
            </div>
          </div>

          <TrendChart data={usageData} metric={metric} />

          {showTable && (
            <div className="overflow-x-auto max-h-64">
              <table className="table table-xs">
                <thead>
                  <tr className="text-base-content/50">
                    <th>Period</th>
                    <th className="text-right">Requests</th>
                    <th className="text-right">Tokens</th>
                    <th className="text-right">Saved</th>
                    <th className="text-right">Cost</th>
                    <th className="text-right">Cost saved</th>
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {usageData.map((point) => (
                    <tr key={point.period}>
                      <td className="whitespace-nowrap">{point.period}</td>
                      <td className="text-right">{formatCount(point.requests)}</td>
                      <td className="text-right">{formatTokens(point.totalTokens)}</td>
                      <td className="text-right">{formatTokens(point.tokensSaved)}</td>
                      <td className="text-right">{formatCost(point.totalCost)}</td>
                      <td className="text-right">{formatCost(point.costSaved)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="card bg-base-200 border border-base-300 shadow-sm lg:col-span-2">
          <div className="card-body p-5 space-y-4">
            <h3 className="card-title text-sm font-bold tracking-wide">TOP MODELS BY TOKENS</h3>
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
              emptyMessage="No model traffic in this window"
            />
            {modelStats.some((model) => model.totalCost === 0 && model.totalTokens > 0) && (
              <p className="text-[10px] text-base-content/40">
                "unpriced" models have no known rate and count as $0. Set one on the provider's
                Models table to include them in spend.
              </p>
            )}
          </div>
        </div>

        <div className="card bg-base-200 border border-base-300 shadow-sm">
          <div className="card-body p-5 space-y-4">
            <h3 className="card-title text-sm font-bold tracking-wide">PROVIDERS</h3>
            <BarList
              items={providerStats.map((entry) => ({
                label: entry.provider,
                value: entry.totalTokens,
                secondary: formatCost(entry.totalCost),
              }))}
              format={formatTokens}
              emptyMessage="No provider traffic yet"
            />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="card bg-base-200 border border-base-300 shadow-sm">
          <div className="card-body p-5 space-y-4">
            <h3 className="card-title text-sm font-bold tracking-wide">SPEND BY CLIENT</h3>
            <BarList
              items={clientStats.slice(0, 8).map((entry) => ({
                label: entry.clientId,
                value: entry.totalCost,
                secondary: `${formatCount(entry.requests)} req`,
              }))}
              format={formatCost}
              emptyMessage="No client attribution yet"
            />
          </div>
        </div>

        <div className="card bg-base-200 border border-base-300 shadow-sm">
          <div className="card-body p-5 space-y-4">
            <h3 className="card-title text-sm font-bold tracking-wide flex items-center gap-2">
              <KeyRound className="w-4 h-4 text-primary" />
              SPEND BY API KEY
            </h3>
            <BarList
              items={apiKeyStats.map((entry) => ({
                label: `${entry.name}${entry.revoked ? ' (revoked)' : ''}`,
                value: entry.totalCost,
                secondary: `${formatCount(entry.requests)} req`,
              }))}
              format={formatCost}
              emptyMessage="No key-attributed traffic yet"
            />
            <p className="text-[10px] text-base-content/40">
              "no key" covers requests made while gateway key auth was switched off.
            </p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4">
        <div className="card bg-base-200 border border-base-300 shadow-sm">
          <div className="card-body p-5 space-y-3">
            <h3 className="card-title text-sm font-bold tracking-wide">RECENT REQUESTS</h3>
            <div className="overflow-x-auto max-h-80">
              <table className="table table-xs">
                <thead>
                  <tr className="text-base-content/50">
                    <th>Time</th>
                    <th>Model</th>
                    <th>Client</th>
                    <th>API key</th>
                    <th className="text-right">In / Out</th>
                    <th className="text-right">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {(recent ?? []).map((log) => (
                    <tr key={log.id}>
                      <td className="whitespace-nowrap text-base-content/60">
                        {formatTimestamp(log.timestamp)}
                      </td>
                      <td className="font-mono font-semibold">
                        {log.fullModelName}
                        {log.estimated === 1 && (
                          <span
                            className="badge badge-xs badge-ghost ml-1.5 font-bold"
                            title="The upstream reported no usage — these numbers are estimated"
                          >
                            est
                          </span>
                        )}
                      </td>
                      <td className="text-base-content/60">{log.clientId}</td>
                      <td className="text-base-content/60">
                        {log.apiKeyName || (
                          <span className="text-base-content/30 italic">no key</span>
                        )}
                      </td>
                      <td className="text-right font-mono">
                        {formatTokens(log.inputTokens)} / {formatTokens(log.outputTokens)}
                      </td>
                      <td className="text-right font-mono">{formatCost(log.totalCost)}</td>
                    </tr>
                  ))}
                  {(recent ?? []).length === 0 && (
                    <tr>
                      <td colSpan={6} className="text-center text-base-content/40 py-6">
                        No requests recorded yet
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
