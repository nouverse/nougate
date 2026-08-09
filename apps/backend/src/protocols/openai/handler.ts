import {
  ModelPrefixError,
  formatModelId,
  requireProviderPrefix,
} from "@/core/model-resolver";
import type { IProtocolHandler } from "@/core/interfaces";
import { ProviderUnavailableError } from "@/core/upstream-errors";
import type { RequestContext } from "@/core/request-context";
import { getAllProviders } from "@/core/registry";
import { prepareRequestPayload } from "@/core/metrics/compression";
import { instrumentResponse } from "@/core/metrics/tracker";

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
        legacy_id: `${provider.id}-${modelId}`,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: provider.id,
        provider: provider.id,
      })),
    )
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
      return handleListModels();
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

    const startedAt = Date.now();

    // RTK (inline tool-result compression) then Headroom (semantic compression)
    const { body: compressedBody, compression } = await prepareRequestPayload(openaiBody);

    // Delegate upstream execution dynamically to the resolved provider.
    // A throw here (no usable account, upstream unreachable, exhausted retries)
    // must still reach the client as a protocol-shaped JSON error rather than
    // escaping into the server's default HTML error page.
    let response: Response;
    try {
      response = await ctx.provider.execute({
        protocol: "openai",
        body: compressedBody,
        resolvedModel: ctx.resolvedModel,
        modelSpec,
        ctx,
      });
    } catch (error: any) {
      console.error(
        `[OpenAI] Upstream execution failed for "${ctx.resolvedModel.raw}":`,
        error,
      );

      // A provider that knows it is only temporarily out says so, and for how
      // long. Answering 502 for that told clients the gateway was broken.
      if (error instanceof ProviderUnavailableError) {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        };
        if (error.retryAfterSeconds) {
          headers["Retry-After"] = String(error.retryAfterSeconds);
        }

        return new Response(
          JSON.stringify({
            error: {
              message: error.message,
              type: "rate_limit_error",
              code: "rate_limited",
            },
          }),
          { status: error.status, headers },
        );
      }

      return createJsonResponse(
        {
          error: {
            message: error?.message || "Upstream request failed",
            type: "api_error",
            code: "upstream_error",
          },
        },
        502,
      );
    }

    return instrumentResponse(response, {
      provider: ctx.provider.id,
      model: modelSpec.modelId,
      protocol: "openai",
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
