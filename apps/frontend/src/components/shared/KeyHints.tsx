import { ChevronDown, ExternalLink, KeyRound } from 'lucide-react';
import { COST_LABEL, KNOWN_SERVICES, type KnownService } from '@/lib/known-services';

/**
 * "How to get an API key", folded away under the key's field: each service a person is likely to mean, a link to the
 * page where its key is made, whether using it is charged by use or is part of a plan, and a button that fills the
 * form with that service's address. Closed until asked for: most people who reach the field already hold a key.
 *
 * It names no service itself: it draws the list it is handed.
 */
export function KeyHints({
  services = KNOWN_SERVICES,
  onUse,
}: {
  services?: KnownService[];
  /** Fill the form from a line: its id, name, address and style. */
  onUse?: (service: KnownService) => void;
}) {
  return (
    <details className="group rounded-xl border border-base-300 bg-base-100/60 text-xs">
      <summary className="flex min-h-10 cursor-pointer select-none list-none items-center gap-2 px-3 font-semibold text-base-content/75 hover:text-base-content [&::-webkit-details-marker]:hidden">
        <KeyRound className="w-3.5 h-3.5 shrink-0" />
        How to get an API key
        <ChevronDown className="w-3.5 h-3.5 ml-auto shrink-0 transition-transform group-open:rotate-180" />
      </summary>
      <ul className="divide-y divide-base-300 border-t border-base-300">
        {services.map((service) => (
          <li key={service.id} className="space-y-1 px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <a
                href={service.keyUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 font-bold link link-primary link-hover"
              >
                {service.displayName}
                <ExternalLink className="w-3 h-3" />
              </a>
              <span
                className={`badge badge-xs font-semibold ${service.cost === 'included' ? 'badge-success badge-soft' : 'badge-ghost'}`}
              >
                {COST_LABEL[service.cost]}
              </span>
              {onUse && (
                <button
                  type="button"
                  className="btn btn-ghost btn-xs ml-auto rounded-lg font-semibold"
                  aria-label={`Use ${service.displayName}`}
                  onClick={() => onUse(service)}
                >
                  Use it
                </button>
              )}
            </div>
            <p className="text-[11px] leading-relaxed text-base-content/60">{service.note}</p>
          </li>
        ))}
      </ul>
    </details>
  );
}
