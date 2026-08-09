import {
  ModelPrefixError,
  formatModelId,
  requireProviderPrefix,
} from "@/core/model-resolver";
import type { IProtocolHandler } from "@/core/interfaces";
import { ProviderResponseError } from "@/core/upstream-errors";
import type { RequestContext } from "@/core/request-context";
import { getAllProviders } from "@/core/registry";
import { prepareRequestPayload } from "@/core/metrics/compression";
import { instrumentResponse } from "@/core/metrics/tracker";
import { executeProviderRequest } from "@/core/provider-execute";

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

    try {
      requireProviderPrefix(ctx.resolvedModel);
    } catch (error) {
      if (error instanceof ModelPrefixError) {
        return createErrorResponse(error.message, "invalid_request_error", error.status);
      }
      throw error;
    }

    let anthropicBody: any;
    try {
      anthropicBody = await ctx.req.json();
    } catch (error: any) {
      return createErrorResponse(error?.message || "Invalid JSON body", "invalid_request_error", 400);
    }

    const modelSpec = ctx.provider.getModelRegistry().getSpec(ctx.resolvedModel.modelId);
    if (!modelSpec) {
      return createErrorResponse(`Unknown model "${anthropicBody.model}"`, "invalid_request_error", 400);
    }

    const startedAt = Date.now();

    // RTK (inline tool-result compression) then Headroom (semantic compression)
    const { body: compressedBody, compression } = await prepareRequestPayload(anthropicBody);

    // Delegate upstream execution dynamically to the resolved provider.
    // A throw here (no usable account, upstream unreachable, exhausted retries)
    // must still reach the client as a protocol-shaped JSON error rather than
    // escaping into the server's default HTML error page.
    let response: Response;
    try {
      response = await executeProviderRequest(ctx.provider, {
        protocol: "anthropic",
        body: compressedBody,
        resolvedModel: ctx.resolvedModel,
        modelSpec,
        ctx,
      });
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

    return instrumentResponse(response, {
      provider: ctx.provider.id,
      model: modelSpec.modelId,
      protocol: "anthropic",
      clientId: ctx.clientId,
      sessionId: ctx.sessionId,
      apiKeyId: ctx.apiKeyId ?? null,
      modelSpec,
      estimatedInputTokens: compression.tokensAfter,
      compression,
      startedAt,
    });
  }
}
