import {
  ModelPrefixError,
  formatModelId,
  requireProviderPrefix,
} from "@/core/model-resolver";
import type { IProtocolHandler } from "@/core/interfaces";
import type { RequestContext } from "@/core/request-context";

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
 */
function handleListModels(ctx: RequestContext): Response {
  const data = ctx.provider
    .getModelRegistry()
    .listModelIds()
    .map((modelId) => ({
      id: formatModelId(ctx.provider.id, modelId),
      display_name: modelId,
      created_at: "2024-01-01T00:00:00Z",
      type: "model",
    }))
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
      return handleListModels(ctx);
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

    // Delegate upstream execution dynamically to the resolved provider
    return ctx.provider.execute({
      protocol: "anthropic",
      body: anthropicBody,
      resolvedModel: ctx.resolvedModel,
      modelSpec,
      ctx,
    });
  }
}
