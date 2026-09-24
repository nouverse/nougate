import { useEffect, useMemo, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { useModelCatalog } from '@/hooks/useQueries';
import { copyText } from '@/lib/clipboard';

interface Props {
  value: string;
  /** Optional label rendered next to the icon. */
  label?: string;
  className?: string;
  title?: string;
}

/**
 * Copies a value to the clipboard and confirms inline for two seconds.
 */
export function CopyButton({ value, label, className = '', title }: Props) {
  const [copied, setCopied] = useState(false);

  // Reset the confirmation if the button gets reused for a different value.
  useEffect(() => {
    setCopied(false);
  }, [value]);

  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      title={title ?? `Copy ${value}`}
      aria-label={title ?? `Copy ${value}`}
      className={`btn btn-ghost btn-xs px-1.5 gap-1 ${copied ? 'text-success' : 'text-base-content/40 hover:text-base-content'} ${className}`}
      onClick={(event) => {
        event.stopPropagation();
        void copyText(value).then((ok) => ok && setCopied(true));
      }}
    >
      {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
      {label && <span className="text-[10px] font-semibold">{copied ? 'Copied' : label}</span>}
    </button>
  );
}

/**
 * A model identifier, copyable in both forms a client can send it.
 *
 * The two are not interchangeable, which is the whole reason both are offered:
 *
 *   - **bare** (`gemini-3.7-flash`) lets the gateway choose the provider, and fail over to another
 *     when the first cannot serve the request.
 *   - **prefixed** (`antigravity:gemini-3.7-flash`) pins it. An explicit prefix is an instruction, so
 *     routing never overrides it — a spent quota here stays a spent quota.
 *
 * The displayed text is the prefixed form, because that is what identifies the row. The bare button
 * is labelled rather than a bare icon for the same reason: a copy button beside
 * `antigravity:gemini-3.7-flash` that silently yields something else is a small betrayal.
 */
export function ModelIdChip({ providerId, modelId }: { providerId: string; modelId: string }) {
  const full = `${providerId}:${modelId}`;
  const { data: catalog } = useModelCatalog();

  // Every catalogue entry for a given model id carries the same routing order, so the first match
  // answers it. React Query serves all of these chips from one cached fetch.
  const routedBy = useMemo(
    () => catalog?.find((entry) => entry.modelId === modelId)?.smartRoutedBy ?? [],
    [catalog, modelId],
  );

  // The case worth flagging: copying the bare id from *this* provider's page would send the request
  // somewhere else first. Silently handing that over is how "I copied it from the Antigravity page"
  // turns into a request nobody can explain.
  const elsewhereFirst = routedBy.length > 0 && routedBy[0] !== providerId;

  const bareTitle =
    routedBy.length === 0
      ? `Copy "${modelId}" — sent without a prefix. No provider can serve it right now.`
      : `Copy "${modelId}" — sent without a prefix, so the gateway picks: ${routedBy.join(' → ')}`;

  return (
    <span className="inline-flex flex-col gap-0.5 max-w-full group">
      <span className="inline-flex items-center gap-1 max-w-full">
        <code className="font-mono text-xs font-semibold select-all truncate" title={full}>
          <span className="text-primary">{providerId}:</span>
          <span className="text-base-content">{modelId}</span>
        </code>
        <CopyButton
          value={full}
          title={`Copy "${full}" — pinned to ${providerId}, never routed elsewhere`}
        />
      </span>

      {/* The same model as the gateway will route it. Shown rather than hidden behind a button:
          which string you send is the decision being made here, and a decision is easier to make
          when both options are on screen. */}
      <span className="inline-flex items-center gap-1 max-w-full">
        <code
          className={`font-mono text-[11px] select-all truncate ${
            elsewhereFirst ? 'text-warning' : 'text-base-content/50'
          }`}
          title={bareTitle}
        >
          {modelId}
        </code>
        <CopyButton
          value={modelId}
          className={elsewhereFirst ? 'text-warning hover:text-warning' : ''}
          title={bareTitle}
        />
      </span>
    </span>
  );
}
