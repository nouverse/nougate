import { useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';

interface Props {
  title: ReactNode;
  /** Shown on the right of the header, e.g. a count. */
  badge?: ReactNode;
  subtitle?: string;
  icon?: ReactNode;
  defaultOpen?: boolean;
  /** Rendered only while open, so heavy contents cost nothing when collapsed. */
  children: () => ReactNode;
  onOpen?: () => void;
}

/**
 * A card whose body is mounted only while it is open.
 *
 * `children` is a function rather than a node on purpose: passing a node would
 * build the whole subtree even when collapsed, which defeats the point for
 * panels holding hundreds of rows.
 */
export function CollapsibleCard({
  title,
  badge,
  subtitle,
  icon,
  defaultOpen = false,
  children,
  onOpen,
}: Props) {
  const [open, setOpen] = useState(defaultOpen);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) {
      onOpen?.();
    }
  };

  return (
    <div className="card bg-base-200 border border-base-300 shadow-sm min-w-0">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex items-center gap-3 w-full p-5 text-left hover:bg-base-300/40 transition-colors rounded-2xl"
      >
        <ChevronRight
          className={`w-4 h-4 shrink-0 text-base-content/40 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        {icon}
        <div className="min-w-0 flex-1">
          <span className="card-title text-sm font-bold tracking-wide block">{title}</span>
          {subtitle && (
            <span className="text-xs text-base-content/50 font-normal block mt-0.5">{subtitle}</span>
          )}
        </div>
        {badge}
      </button>

      {open && <div className="px-5 pb-5 space-y-4 min-w-0">{children()}</div>}
    </div>
  );
}
