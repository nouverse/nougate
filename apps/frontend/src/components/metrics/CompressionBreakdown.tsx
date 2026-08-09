import { Scissors } from 'lucide-react';

import { BarList } from '@/components/metrics/BarList';
import { formatCost, formatCount, formatTokens } from '@/lib/format';
import type { CompressionBreakdown as Breakdown } from '@/lib/types';

/** Engines the gateway ships today; anything else falls back to its raw key. */
const ENGINE_LABELS: Record<string, string> = {
  rtk: 'RTK (tool-result compression)',
  headroom: 'Headroom (semantic compression)',
};

interface Props {
  breakdown: Breakdown;
  /** Input rate for the window, used to price the tokens each engine removed. */
  inputPricePer1M: number;
}

/**
 * Which engine saved what.
 *
 * The headline "saved by compression" tile answers *how much*; this answers
 * *by what*, which is the question you need to decide whether an engine is
 * worth keeping switched on.
 */
export function CompressionBreakdown({ breakdown, inputPricePer1M }: Props) {
  return (
    <div className="card bg-base-200 border border-base-300 shadow-sm min-w-0">
      <div className="card-body p-5 space-y-4">
        <div className="min-w-0">
          <h3 className="card-title text-sm font-bold tracking-wide flex items-center gap-2">
            <Scissors className="w-4 h-4 text-primary shrink-0" />
            SAVINGS BY ENGINE
          </h3>
          <p className="text-xs text-base-content/50 mt-0.5">
            Tokens each pass removed before the request left the gateway.
          </p>
        </div>

        {!breakdown.available ? (
          <p className="text-xs text-base-content/40 py-6 text-center">
            Per-engine detail is kept for 14 days. This window is served from the daily rollups,
            which store one combined total — pick a shorter range to see the split.
          </p>
        ) : (
          <>
            <BarList
              items={breakdown.engines.map((engine) => ({
                label: ENGINE_LABELS[engine.engine] ?? engine.engine,
                value: engine.tokensSaved,
                secondary: `${engine.sharePercent.toFixed(0)}%`,
              }))}
              format={formatTokens}
              emptyMessage="No compression ran in this window — check that RTK or Headroom is enabled."
            />

            {breakdown.engines.length > 0 && (
              <div className="overflow-x-auto min-w-0">
                <table className="table table-sm">
                  <thead>
                    <tr className="text-base-content/50 text-[10px] uppercase tracking-wider">
                      <th>Engine</th>
                      <th className="text-right">Requests</th>
                      <th className="text-right">Tokens saved</th>
                      <th className="text-right">Est. value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {breakdown.engines.map((engine) => (
                      <tr key={engine.engine}>
                        <td className="font-semibold">
                          {ENGINE_LABELS[engine.engine] ?? engine.engine}
                        </td>
                        <td className="text-right font-mono">{formatCount(engine.requests)}</td>
                        <td className="text-right font-mono">{formatTokens(engine.tokensSaved)}</td>
                        <td className="text-right font-mono">
                          {inputPricePer1M > 0
                            ? formatCost((engine.tokensSaved / 1_000_000) * inputPricePer1M)
                            : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <p className="text-[10px] text-base-content/40 leading-relaxed">
              Token counts are estimated from payload size (~4 characters per token), measured
              between passes. "Requests" counts how many requests each engine ran on, so an engine
              that is enabled but found nothing to compress still appears, at zero.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
