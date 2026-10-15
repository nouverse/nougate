/**
 * A host process that runs this gateway inside itself and shows its dashboard inside its own.
 *
 * Nouride's router editions do exactly that: the gateway answers in the daemon's process, and its
 * dashboard is a page of Nouride's ("LLM Gateway") under a path Nouride chooses. Two facts then
 * belong to the host, per request:
 *
 * - **Who is signed in.** The host checked its own session before it handed the request over.
 *   Asking for this gateway's password as well would be a second login to the same box, with a
 *   second password to forget.
 * - **Where the dashboard lives.** The bundle, its API calls and its redirects have to carry the
 *   host's prefix, or the page loads and every request it makes goes to the host's own routes.
 *
 * ## Why the host answers from the request *object*
 *
 * Never a header. A request that arrived over the network was created by the server that accepted
 * it, so the host has never seen that object and cannot vouch for it — whatever cookies, headers or
 * paths it carries. Only a request the host built itself, after checking its own session, can be
 * one it recognises. Nouride keeps those in a `WeakMap`; the gateway asks and does not care how.
 */

export interface HostRequest {
  /** The host's name for the signed-in person. Shown in the dashboard, never stored here. */
  username: string;
  /** Where the host serves this gateway, e.g. `/llm-gateway`. Empty for the root; no trailing slash. */
  basePath: string;
  /**
   * Where a *client* reaches this gateway's API from the viewer's network, e.g. `http://box:18256`.
   *
   * The dashboard shows it on the API Keys and Playground pages, and inside a host its own origin
   * is the host's — the wrong port for every client that copies it. Absent when the host cannot
   * say, and the page then falls back to its own origin as it always has.
   */
  apiOrigin?: string;
}

export type HostResolver = (req: Request) => HostRequest | null;

/**
 * Path segments of unreserved characters only.
 *
 * The prefix ends up inside the dashboard's HTML, so it is checked here rather than trusted: a host
 * that handed over `"/><script>` would otherwise be writing markup. Not a threat from a network
 * peer — they cannot reach this — but a rule this cheap is not worth leaving to every host.
 */
const BASE_PATH = /^(?:\/[A-Za-z0-9._~-]+)*$/;

/** An origin and nothing else: no path, no quotes, nothing that could close an attribute. */
const ORIGIN = /^https?:\/\/[A-Za-z0-9.\-[\]:]+$/;

let resolver: HostResolver | null = null;

/** Set by `boot()`. Null for a gateway that is its own process, which is every standalone run. */
export function setHostResolver(next: HostResolver | null): void {
  resolver = next;
}

/** What the host says about this request, or null when it says nothing or says it badly. */
export function hostRequest(req: Request): HostRequest | null {
  if (!resolver) return null;
  const found = resolver(req);
  if (!found || typeof found.username !== "string" || !found.username) return null;
  if (typeof found.basePath !== "string" || !BASE_PATH.test(found.basePath)) return null;
  if (found.apiOrigin !== undefined && !ORIGIN.test(found.apiOrigin)) {
    const { apiOrigin: _dropped, ...rest } = found;
    return rest;
  }
  return found;
}

/** The prefix this request's dashboard lives under — empty for the gateway's own port. */
export function basePathFor(req: Request): string {
  return hostRequest(req)?.basePath ?? "";
}
