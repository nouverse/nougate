/**
 * The dashboard's entry document, addressed for wherever it is being served from.
 *
 * The bundle is built with a relative base (`./assets/…`), so one build serves the gateway's own
 * port (`/frontend/`) and a host that mounts it under a prefix (`/llm-gateway/frontend/`). Relative
 * URLs alone would break on a deep link — `/frontend/providers/codex` resolves `./assets/` to
 * `/frontend/providers/assets/` — so the document's references are made absolute here, per request,
 * against the prefix this request came through.
 *
 * What the page itself needs to know travels in a `<meta>` tag rather than an inline script: a host
 * that forbids inline scripts in its Content-Security-Policy (Nouride does) would otherwise block the
 * one line the dashboard cannot start without.
 */

export interface EntryContext {
  /** `""` on the gateway's own port; the host's mount point otherwise, e.g. `/llm-gateway`. */
  basePath: string;
  /** Served inside a host's dashboard: its own chrome and sign-in are the host's. */
  embedded: boolean;
  /** Where clients reach the API, when a host said (`HostRequest.apiOrigin`). */
  apiOrigin?: string;
}

/** Quote a value for a double-quoted HTML attribute. */
function attribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Third-party font links.
 *
 * Dropped inside a host, whose policy allows only its own origin: the browser would refuse them
 * anyway, one console error each, and a box on someone's network has no business announcing every
 * dashboard visit to a font CDN. The page falls back to the system font stack.
 */
const FONT_LINKS = /[ \t]*<link\b[^>]*\bfonts\.(?:googleapis|gstatic)\.com\b[^>]*>\s*/gi;

export function renderEntryDocument(html: string, context: EntryContext): string {
  const prefix = `${context.basePath}/frontend/`;
  // The build is relative: `./assets/…`, `./favicon.svg`. A bundle from before that is not rewritten
  // — on this port its absolute paths are already right, and a host does not frame it at all
  // (`isEmbeddable`), so there is no second case to carry.
  let out = html.replace(/(\s(?:src|href)=")\.\//g, `$1${prefix}`);

  if (context.embedded) {
    out = out.replace(FONT_LINKS, "");
  }

  const meta = `<meta name="nougate-host" content="${attribute(JSON.stringify(context))}" />`;
  return out.includes("</head>") ? out.replace("</head>", `  ${meta}\n  </head>`) : `${meta}\n${out}`;
}

/**
 * Whether a built entry document is one that can be shown inside a host.
 *
 * The bundle says so itself, in `apps/frontend/index.html`. Asked rather than assumed because the
 * bundle is a directory beside the executable and is not always replaced with it: Nouride's updates
 * moved the binary and not this directory until 2026-10-15, and a bundle from before host mode,
 * framed, calls the host's `/api` instead of this gateway's.
 */
export function isEmbeddable(html: string): boolean {
  return /<meta\s+name="nougate-embeddable"\s+content="1"/.test(html);
}
