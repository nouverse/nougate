import React from 'react';

interface Props {
  label: string;
  value: string;
  hint?: string;
  icon?: React.ReactNode;
  /** Small trailing badge, e.g. "estimated" or a percentage. */
  badge?: string;
}

/**
 * A headline number. No plot, so no hover layer — the value is the whole point.
 */
export function StatTile({ label, value, hint, icon, badge }: Props) {
  return (
    <div className="card bg-base-200 border border-base-300 shadow-sm">
      <div className="card-body p-4 gap-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] font-bold uppercase tracking-wider text-base-content/50">
            {label}
          </span>
          {icon && <span className="text-base-content/30">{icon}</span>}
        </div>

        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-2xl font-extrabold tracking-tight text-base-content font-mono">
            {value}
          </span>
          {badge && (
            <span className="badge badge-xs badge-neutral border-0 bg-base-300 text-base-content/60 font-bold">
              {badge}
            </span>
          )}
        </div>

        {hint && <span className="text-[11px] text-base-content/50">{hint}</span>}
      </div>
    </div>
  );
}
