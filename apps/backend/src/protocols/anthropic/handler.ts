import { formatModelId } from "@/core/model-resolver";
import type { IProtocolHandler } from "@/core/interfaces";
import { ProviderResponseError } from "@/core/upstream-errors";
import type { RequestContext } from "@/core/request-context";
import { getAllProviders } from "@/core/registry";
import { prepareRequestPayload } from "@/core/metrics/compression";
import { instrumentResponse } from "@/core/metrics/tracker";
import { executeWithFailover } from "@/core/provider-execute";
import { explainNoCandidate, routeCandidates } from "@/core/smart-routing";

/**
 * Build a JSON response with the shared CORS and proxy headers.
 */
function createJsonResponse(body: unknown, status: number, attempts?: number): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  if (attempts !== undefined) {
    headers["X-Antigravity-Attempts"] = attempts.toString();
  }

  return new Response(JSON.stringify(body), {
    status,
    headers,
  });
}

/**
 * Build an Anthropic-compatible error response.
 */
function createErrorResponse(message: string, type = "invalid_request_error", status = 400): Response {
  return createJsonResponse({
    type: "error",
    error: {
      type,
      message,
    }
  }, status);
}

/**
 * Handle Anthropic-compatible model listing responses.
 *
 * Every registered provider is listed, since a client picks the provider by
 * sending the `provider:model` prefix — a list scoped to one provider would
 * hide the rest from model pickers.
 */
function handleListModels(): Response {
  const data = getAllProviders()
    .flatMap((provider) =>
      provider.getModelRegistry().listModelIds().map((modelId) => ({
        id: formatModelId(provider.id, modelId),
        display_name: modelId,
        created_at: "2024-01-01T00:00:00Z",
        type: "model",
      })),
    )
    .sort((a, b) => a.id.localeCompare(b.id));

  return createJsonResponse(
    {
      data,
    },
    200,
  );
}

/**
 * Anthropic-compatible protocol handler.
 */
export class AnthropicProtocolHandler implements IProtocolHandler {
  readonly protocol = "anthropic" as const;
  readonly paths = ["/anthropic/v1/messages", "/anthropic/v1/models"];
  readonly methods = ["POST", "GET"];

  /**
   * Dispatch the current request to the matching Anthropic-compatible route.
   */
  async handle(ctx: RequestContext): Promise<Response> {
    if (ctx.url.pathname === "/anthropic/v1/models" && ctx.req.method === "GET") {
      return handleListModels();
    }

    let anthropicBody: any;
    try {
      anthropicBody = await ctx.req.json();
    } catch (error: any) {
      return createErrorResponse(error?.message || "Invalid JSON body", "invalid_request_error", 400);
    }

    // An unprefixed model fans out across every provider that declares it; a prefixed one resolves
    // to exactly that provider. Either way what comes back is an ordered list, so the two cases
    // share one execution path — see `core/smart-routing`.
    const candidates = routeCandidates(ctx.resolvedModel);
    if (candidates.length === 0) {
      return createErrorResponse(explainNoCandidate(ctx.resolvedModel), "invalid_request_error", 400);
    }

    const startedAt = Date.now();

    // RTK (inline tool-result compression) then Headroom (semantic compression)
    const { body: compressedBody, compression } = await prepareRequestPayload(anthropicBody);

    // Delegate upstream execution dynamically to the resolved provider.
    // A throw here (no usable account, upstream unreachable, exhausted retries)
    // must still reach the client as a protocol-shaped JSON error rather than
    // escaping into the server's default HTML error page.
    let served;
    try {
      served = await executeWithFailover(candidates, (candidate) => ({
        protocol: "anthropic",
        body: compressedBody,
        resolvedModel: ctx.resolvedModel,
        modelSpec: candidate.modelSpec,
        ctx,
      }));
    } catch (error: any) {
      console.error(
        `[Anthropic] Upstream execution failed for "${ctx.resolvedModel.raw}":`,
        error,
      );

      // Self-describing failures answer in Anthropic's own error shape rather
      // than a flat 502, which reads to a client as "the gateway is broken".
      if (error instanceof ProviderResponseError) {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        };
        if (error.retryAfterSeconds) {
          headers["Retry-After"] = String(error.retryAfterSeconds);
        }

        return new Response(
          JSON.stringify({
            type: "error",
            error: {
              type: error.status === 429 ? "rate_limit_error" : "invalid_request_error",
              message: error.message,
            },
          }),
          { status: error.status, headers },
        );
      }

      return createErrorResponse(
        error?.message || "Upstream request failed",
        "api_error",
        502,
      );
    }

    // The provider that *served*, not the one that was picked first — otherwise a failed-over
    // request bills the provider that refused it.
    return instrumentResponse(served.response, {
      provider: served.provider.id,
      model: served.modelSpec.modelId,
      protocol: "anthropic",
      clientId: ctx.clientId,
      sessionId: ctx.sessionId,
      apiKeyId: ctx.apiKeyId ?? null,
      modelSpec: served.modelSpec,
      estimatedInputTokens: compression.tokensAfter,
      compression,
      startedAt,
    });
  }
}
