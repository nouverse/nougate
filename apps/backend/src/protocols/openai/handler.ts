import {
  ModelPrefixError,
  formatModelId,
  requireProviderPrefix,
} from "@/core/model-resolver";
import type { IProtocolHandler } from "@/core/interfaces";
import type { RequestContext } from "@/core/request-context";

/**
 * Build a JSON response with the shared OpenAI proxy headers.
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
 * Derive a deterministic session ID from the request body when possible.
 */
export function buildSessionId(openaiBody: any, clientId: string): string {
  const firstMessage = openaiBody.messages?.[0]?.content || "";
  const userIdentifier = openaiBody.user || clientId;
  const stableSeed = `${userIdentifier}:${
    typeof firstMessage === "string" ? firstMessage : JSON.stringify(firstMessage)
  }`;

  return firstMessage
    ? new Bun.CryptoHasher("sha256").update(stableSeed).digest("hex")
    : crypto.randomUUID();
}

/**
 * Handle OpenAI-compatible model listing responses.
 */
function handleListModels(ctx: RequestContext): Response {
  const data = ctx.provider
    .getModelRegistry()
    .listModelIds()
    .map((modelId) => ({
      id: formatModelId(ctx.provider.id, modelId),
      legacy_id: `${ctx.provider.id}-${modelId}`,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: ctx.provider.id,
      provider: ctx.provider.id,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return createJsonResponse(
    {
      object: "list",
      data,
    },
    200,
  );
}

/**
 * OpenAI-compatible protocol handler for chat completions and model listing.
 */
export class OpenAIProtocolHandler implements IProtocolHandler {
  readonly protocol = "openai" as const;
  readonly paths = ["/openai/v1/chat/completions", "/openai/v1/models"];
  readonly methods = ["POST", "GET"];

  /**
   * Dispatch the current request to the matching OpenAI-compatible route.
   */
  async handle(ctx: RequestContext): Promise<Response> {
    if (ctx.url.pathname === "/openai/v1/models" && ctx.req.method === "GET") {
      return handleListModels(ctx);
    }

    try {
      requireProviderPrefix(ctx.resolvedModel);
    } catch (error) {
      if (error instanceof ModelPrefixError) {
        return createJsonResponse(
          {
            error: {
              message: error.message,
              type: "invalid_request_error",
              code: "model_prefix_required",
            },
          },
          error.status,
        );
      }
      throw error;
    }

    let openaiBody: any;
    try {
      openaiBody = await ctx.req.json();
    } catch (error: any) {
      return createJsonResponse(
        {
          error: {
            message: error?.message || "Invalid JSON body",
            type: "invalid_request_error",
            code: "invalid_json",
          },
        },
        400,
      );
    }

    const modelSpec = ctx.provider.getModelRegistry().getSpec(ctx.resolvedModel.modelId);
    if (!modelSpec) {
      return createJsonResponse(
        {
          error: {
            message: `Unknown model "${openaiBody.model}"`,
            type: "invalid_request_error",
            code: "model_not_found",
          },
        },
        400,
      );
    }

    // Delegate upstream execution dynamically to the resolved provider
    return ctx.provider.execute({
      protocol: "openai",
      body: openaiBody,
      resolvedModel: ctx.resolvedModel,
      modelSpec,
      ctx,
    });
  }
}
