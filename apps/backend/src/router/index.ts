import { getDefaultProvider, getProvider, findHandler } from "@/core/registry";
import { resolveModel } from "@/core/model-resolver";
import { buildSessionId } from "@/protocols/openai/handler";
import { handleAdminRoute } from "@/router/admin";
import { handleAuthRoute } from "@/router/auth";
import { enforceDashboardAuth } from "@/auth/guard";
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

  const authDenial = enforceDashboardAuth(req, routedUrl);
  if (authDenial) {
    return withCorsHeaders(authDenial);
  }

  const handler = findHandler(cleanPath, req.method);
  if (handler) {
    const previewBody = await getPreviewBody(req);
    const clientId =
      req.headers.get("x-client-id") ||
      routedUrl.searchParams.get("client_id") ||
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
      }),
    );
  }

  const adminResponse = await handleAdminRoute(req, routedUrl);
  if (adminResponse) {
    return withCorsHeaders(adminResponse);
  }

  return withCorsHeaders(new Response("Not Found", { status: 404 }));
}
