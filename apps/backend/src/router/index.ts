import { getDefaultProvider, getProvider, findHandler } from "@/core/registry";
import { resolveModel } from "@/core/model-resolver";
import { buildSessionId } from "@/protocols/openai/handler";
import { handleAdminRoute } from "@/router/admin";
import { handleAuthRoute } from "@/router/auth";
import { enforceDashboardAuth } from "@/auth/guard";
import { extractApiKey, findApiKeyById, touchApiKey, verifyApiKey } from "@/auth/api-keys";
import { getActiveUser } from "@/auth/guard";
import {
  handleCorsPreflight,
  logIncomingRequest,
  normalizePathname,
  withCorsHeaders,
} from "@/router/middleware";

/**
 * Read a shallow preview of the request body so routing can derive model and session data.
 */
async function getPreviewBody(req: Request): Promise<any> {
  if (req.method === "GET" || req.method === "HEAD") {
    return {};
  }

  try {
    return await req.clone().json();
  } catch {
    return {};
  }
}

/**
 * Resolve the provider context for a protocol request.
 */
function resolveProviderForRequest(model: string) {
  const resolvedModel = resolveModel(model);
  const provider =
    resolvedModel.providerId !== null
      ? getProvider(resolvedModel.providerId) || getDefaultProvider()
      : getDefaultProvider();

  return { resolvedModel, provider };
}

/**
 * The dashboard Playground, standing in for a gateway key it cannot possibly hold.
 *
 * Keys are stored hashed, so a signed-in operator cannot be handed one back — which is why the
 * Playground used to demand the secret be pasted in, and why forgetting it meant minting a throwaway
 * key just to try a prompt. What it actually needs is not permission (a signed-in operator already
 * outranks any key they could mint) but *attribution*: which key this request should be billed and
 * charted against.
 *
 * So the session authorises and the header names the ledger. The header is what keeps this from
 * widening the CSRF surface: a custom header forces a CORS preflight, and a forged cross-site
 * request cannot satisfy one — while `Access-Control-Allow-Origin: *` on these routes already stops
 * a browser from attaching cookies cross-origin at all.
 */
async function resolvePlaygroundKey(req: Request): Promise<{ id: string; name: string } | null> {
  const requested = req.headers.get("x-nougate-api-key-id");
  if (!requested) return null;

  const user = await getActiveUser(req);
  if (!user) return null;

  const record = findApiKeyById(requested.trim());
  // Revocation is already enforced one level down — the verification cache is loaded
  // `WHERE revoked = 0`, so a revoked key is simply not found. The flag is checked anyway, for the
  // same reason `verifyApiKey` checks it: this must never be the place that outlives that guarantee.
  if (!record || record.revoked) return null;
  if (record.expiresAt && record.expiresAt < Date.now()) return null;

  return { id: record.id, name: record.name };
}

const API_KEY_ERROR_MESSAGES: Record<string, string> = {
  missing:
    "Missing gateway API key. Send it as 'Authorization: Bearer sk-nou-...' or 'x-api-key: sk-nou-...'.",
  invalid: "Invalid gateway API key.",
  revoked: "This gateway API key has been revoked.",
  expired: "This gateway API key has expired.",
};

/**
 * Build a protocol-appropriate 401 for a rejected gateway key.
 */
function apiKeyDenied(protocol: string, reason: string): Response {
  const message = API_KEY_ERROR_MESSAGES[reason] ?? API_KEY_ERROR_MESSAGES.invalid;
  const body =
    protocol === "anthropic"
      ? { type: "error", error: { type: "authentication_error", message } }
      : { error: { message, type: "invalid_request_error", code: "invalid_api_key" } };

  return new Response(JSON.stringify(body), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Handle every incoming HTTP request for the backend.
 */
export async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const cleanPath = normalizePathname(url.pathname);
  const routedUrl = new URL(req.url);
  routedUrl.pathname = cleanPath;

  logIncomingRequest(req, cleanPath);

  const preflightResponse = handleCorsPreflight(req);
  if (preflightResponse) {
    return preflightResponse;
  }

  // Auth endpoints are same-origin browser navigations that set cookies, so they
  // bypass withCorsHeaders to keep their Set-Cookie headers intact.
  const authResponse = await handleAuthRoute(req, routedUrl);
  if (authResponse) {
    return authResponse;
  }

  const authDenial = await enforceDashboardAuth(req, routedUrl);
  if (authDenial) {
    return withCorsHeaders(authDenial);
  }

  const handler = findHandler(cleanPath, req.method);
  if (handler) {
    // Every proxied request carries a gateway key. There is no switch: an
    // instance with no keys yet serves nobody, which is the safe direction for
    // something reachable from the internet.
    const verification = verifyApiKey(extractApiKey(req));
    const playgroundKey = verification.ok ? null : await resolvePlaygroundKey(req);
    if (!verification.ok && !playgroundKey) {
      return withCorsHeaders(apiKeyDenied(handler.protocol, verification.reason));
    }

    const identity = verification.ok
      ? { id: verification.record.id, name: verification.record.name }
      : playgroundKey!;
    const apiKeyId = identity.id;
    const apiKeyName = identity.name;
    touchApiKey(apiKeyId);

    const previewBody = await getPreviewBody(req);
    // An explicit x-client-id still wins, but a gateway key names its own
    // caller — which is what makes per-client cost attribution work.
    const clientId =
      req.headers.get("x-client-id") ||
      routedUrl.searchParams.get("client_id") ||
      apiKeyName ||
      "unknown";
    const model = String(previewBody.model || `${getDefaultProvider().id}:models`);
    const { resolvedModel, provider } = resolveProviderForRequest(model);

    return withCorsHeaders(
      await handler.handle({
        req,
        url: routedUrl,
        protocol: handler.protocol,
        resolvedModel,
        provider,
        sessionId: buildSessionId(previewBody, clientId),
        clientId,
        apiKeyId,
      }),
    );
  }

  const adminResponse = await handleAdminRoute(req, routedUrl);
  if (adminResponse) {
    return withCorsHeaders(adminResponse);
  }

  return withCorsHeaders(new Response("Not Found", { status: 404 }));
}
