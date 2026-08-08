import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';

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
        navigator.clipboard.writeText(value).then(() => setCopied(true));
      }}
    >
      {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
      {label && <span className="text-[10px] font-semibold">{copied ? 'Copied' : label}</span>}
    </button>
  );
}

/**
 * A full `provider:model` identifier shown as one copyable unit — this is the
 * exact string a client puts in its `model` field.
 */
export function ModelIdChip({ providerId, modelId }: { providerId: string; modelId: string }) {
  const full = `${providerId}:${modelId}`;

  return (
    <span className="inline-flex items-center gap-1 max-w-full group">
      <code className="font-mono text-xs font-semibold select-all truncate" title={full}>
        <span className="text-primary">{providerId}:</span>
        <span className="text-base-content">{modelId}</span>
      </code>
      <CopyButton value={full} title={`Copy "${full}"`} />
    </span>
  );
}
