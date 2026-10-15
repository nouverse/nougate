/**
 * Where this dashboard is being served from, as the gateway told it.
 *
 * One build serves two places: the gateway's own port (`/frontend/`), and inside a host that runs
 * the gateway in its own process and shows this dashboard as one of its pages — Nouride's
 * "LLM Gateway", under `/llm-gateway/`. The server writes which one into a `<meta>` tag of the entry
 * document (`backend/src/router/entry-document.ts`); everything that builds a URL reads it from here.
 *
 * Read once, at load: the answer cannot change without a new document.
 */

export interface HostInfo {
  /** `""` on the gateway's own port, the host's mount point otherwise (`/llm-gateway`). */
  basePath: string;
  /**
   * Shown inside a host's dashboard. The host owns sign-in, the account and the outer navigation,
   * so this page draws none of them.
   */
  embedded: boolean;
  /** Where clients reach the API, when the host said — the page's own origin is the host's. */
  apiOrigin?: string;
}

function read(): HostInfo {
  const fallback: HostInfo = { basePath: '', embedded: false };
  if (typeof document === 'undefined') return fallback;
  const content = document.querySelector('meta[name="nougate-host"]')?.getAttribute('content');
  if (!content) return fallback;
  try {
    const parsed = JSON.parse(content) as Partial<HostInfo>;
    return {
      basePath: typeof parsed.basePath === 'string' ? parsed.basePath : '',
      embedded: parsed.embedded === true,
      ...(typeof parsed.apiOrigin === 'string' && parsed.apiOrigin ? { apiOrigin: parsed.apiOrigin } : {}),
    };
  } catch {
    return fallback;
  }
}

export const host: HostInfo = read();

/** A root-relative path, moved under the host's prefix. Anything else is returned as it is. */
export function withBase(path: string): string {
  return path.startsWith('/') && !path.startsWith('//') ? `${host.basePath}${path}` : path;
}

/** The origin a client should be told to call — this page's own, unless a host said otherwise. */
export function apiOrigin(): string {
  return host.apiOrigin ?? window.location.origin;
}
