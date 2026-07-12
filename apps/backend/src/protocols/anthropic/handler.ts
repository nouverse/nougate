import { AntigravityExecutor } from "../../providers/antigravity/upstream/executor";
import {
  ANTIGRAVITY_SYSTEM_INSTRUCTION,
  getAntigravityConfig,
} from "../../providers/antigravity";
import {
  ModelPrefixError,
  formatModelId,
  requireProviderPrefix,
} from "../../core/model-resolver";
import type { IProtocolHandler } from "../../core/interfaces";
import type { RequestContext } from "../../core/request-context";
import { mapAnthropicToGoogle } from "./mapper-in";
import { createAnthropicStreamTransformer, aggregateAnthropicResponse } from "./mapper-out";

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
 * Finalize the upstream Google response into the current Anthropic response shape.
 */
async function finalizeAnthropicResponse(params: {
  googleRes: Response;
  anthropicBody: any;
  messageId: string;
  sessionId: string;
  attempts: number;
  accountEmail: string;
}) {
  const { googleRes, anthropicBody, messageId, sessionId, attempts, accountEmail } = params;
  const isStreaming = anthropicBody.stream === true;

  if (isStreaming) {
    if (!googleRes.body) {
      return {
        response: createErrorResponse("No response body from upstream", "api_error", 502),
      };
    }

    const stream = googleRes.body.pipeThrough(
      createAnthropicStreamTransformer(anthropicBody.model, messageId, sessionId),
    );
    return {
      response: new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Access-Control-Allow-Origin": "*",
          "X-Antigravity-Attempts": attempts.toString(),
        },
      }),
    };
  }

  if (!googleRes.body) {
    throw new Error("No response body");
  }

  const finalResponse = await aggregateAnthropicResponse(
    googleRes,
    anthropicBody.model,
    messageId,
    sessionId,
  );

  // If the content is empty, trigger a retry
  const hasText = finalResponse.content.some((c: any) => c.text || c.thinking);
  const hasToolUse = finalResponse.content.some((c: any) => c.type === "tool_use");
  if (!hasText && !hasToolUse && finalResponse.stop_reason !== "max_tokens") {
    console.warn(
      `[Empty] Account ${accountEmail} returned empty response for ${anthropicBody.model}, retrying with another account...`,
    );
    return {
      retry: true as const,
      cooldownDuration: "30s",
    };
  }

  return {
    response: createJsonResponse(finalResponse, 200, attempts),
  };
}

/**
 * Handle Anthropic-compatible model listing responses.
 */
function handleListModels(ctx: RequestContext): Response {
  const data = ctx.provider
    .getModelRegistry()
    .listModelIds()
    .map((modelId) => {
      const spec = ctx.provider.getModelRegistry().getSpec(modelId);
      const prefixedId = formatModelId(ctx.provider.id, modelId);
      return {
        type: "model",
        id: prefixedId,
        legacy_id: `${ctx.provider.id}-${modelId}`,
        display_name: spec?.displayName || prefixedId,
        created_at: "2026-01-01T00:00:00Z",
        provider: ctx.provider.id,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  return createJsonResponse(
    {
      data,
      has_more: false,
      first_id: data[0]?.id || null,
      last_id: data[data.length - 1]?.id || null,
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

    const messageId = `msg_${Math.random().toString(36).substring(2, 10)}${Math.random().toString(36).substring(2, 10)}`;
    const executor = new AntigravityExecutor();
    const result = await executor.execute({
      model: anthropicBody.model,
      modelSpec,
      sessionId: ctx.sessionId,
      clientId: ctx.clientId,
      debugRequestBody: anthropicBody,
      buildGoogleBody: ({ aggressive }) => {
        const providerConfig = getAntigravityConfig();
        return mapAnthropicToGoogle(anthropicBody, modelSpec, ctx.sessionId, {
          aggressive,
          systemInstructionPrefix: ANTIGRAVITY_SYSTEM_INSTRUCTION,
          features: {
            sanitizeToolNames: providerConfig.features.sanitizeToolNames,
            keepThinking: providerConfig.features.keepThinking,
            googleSearchGrounding: providerConfig.features.googleSearchGrounding,
            groundingMode: providerConfig.features.groundingMode,
          },
        });
      },
      handleSuccess: async ({ googleRes, account, attempts }) =>
        finalizeAnthropicResponse({
          googleRes,
          anthropicBody,
          messageId,
          sessionId: ctx.sessionId,
          attempts,
          accountEmail: account.email,
        }),
    });

    return result.response;
  }
}
