import { getDefaultProvider, getProvider, findHandler } from "@/core/registry";
import { resolveModel } from "@/core/model-resolver";
import { buildSessionId } from "@/protocols/openai/handler";
import { handleAdminRoute } from "@/router/admin";
import { handleAuthRoute } from "@/router/auth";
import { enforceDashboardAuth } from "@/auth/guard";
import {
  extractApiKey,
  isApiKeyAuthEnabled,
  touchApiKey,
  verifyApiKey,
} from "@/auth/api-keys";
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
    let apiKeyId: string | null = null;
    let apiKeyName: string | null = null;

    if (isApiKeyAuthEnabled()) {
      const verification = verifyApiKey(extractApiKey(req));
      if (!verification.ok) {
        return withCorsHeaders(apiKeyDenied(handler.protocol, verification.reason));
      }

      apiKeyId = verification.record.id;
      apiKeyName = verification.record.name;
      touchApiKey(apiKeyId);
    }

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
