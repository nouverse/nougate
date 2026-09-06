/**
 * Honest framing headers on a response this process re-emits.
 *
 * Every response leaving this provider is a *new* body: `fetch` decompressed the upstream bytes
 * before this code ever saw them, and the streaming paths pipe those bytes through transformers that
 * change their length. The upstream's framing headers describe none of that, so they have to come off
 * before the response is handed on.
 */

/**
 * Headers that describe how the *original* bytes were framed, and are lies about the new ones.
 *
 * `content-encoding: gzip` is the loud one. Copying it onto a decoded body tells the client to gunzip
 * plain JSON, which fails for every single request rather than degrading — and on a stream it
 * corrupts the whole thing before the first event arrives. `curl` hides this, because it only
 * attempts to decode when it asked for compression; a browser always asks, so the same response that
 * prints fine in a terminal surfaces as a bare "network error" in the dashboard.
 *
 * `content-length` is the same class of mistake with a quieter symptom: a re-serialised or
 * transformed body is almost never the same length as what arrived, so the client reads the wrong
 * number of bytes and either truncates the response or waits for bytes that never come.
 *
 * `transfer-encoding` is hop-by-hop and belongs to the connection this process is not making.
 */
const REFRAMED_HEADERS = ['content-encoding', 'content-length', 'transfer-encoding'];

/**
 * The upstream's headers, minus the ones that no longer describe the body being sent.
 *
 * A copy: `response.headers` is immutable on some runtimes and shared on others, so mutating it in
 * place is either a throw or an action at a distance.
 */
export function reframedHeaders(response: Response): Headers {
  const headers = new Headers(response.headers);
  for (const name of REFRAMED_HEADERS) headers.delete(name);
  return headers;
}

/**
 * The upstream response, re-framed for the body this process is actually sending.
 *
 * Applied at the executor rather than at each consumer, because "did this particular path rebuild
 * the body?" is the wrong question to have to get right in four places — the answer is always yes
 * once a decoded body has crossed a runtime boundary, and the one path that used to skip it (an
 * Anthropic passthrough with no tools to rename) was the one that broke.
 */
export function reframeResponse(response: Response): Response {
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: reframedHeaders(response),
  });
}
