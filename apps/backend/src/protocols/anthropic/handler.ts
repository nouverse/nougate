import { formatModelId } from "@/core/model-resolver";
import { listedModalities } from "@/core/model-listing";
import type { IProtocolHandler } from "@/core/interfaces";
import { ProviderResponseError } from "@/core/upstream-errors";
import type { RequestContext } from "@/core/request-context";
import { getAllProviders } from "@/core/registry";
import { prepareRequestPayload } from "@/core/metrics/compression";
import { instrumentResponse } from "@/core/metrics/tracker";
import { executeWithFailover, failoverHeaders, failureOf } from "@/core/provider-execute";
import { explainNoCandidate, routeCandidates } from "@/core/smart-routing";

/**
 * Build a JSON response with the shared CORS and proxy headers, and any of its own.
 */
function createJsonResponse(body: unknown, status: number, attempts?: number, extra: Record<string, string> = {}): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    ...extra,
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
function createErrorResponse(message: string, type = "invalid_request_error", status = 400, extra: Record<string, string> = {}): Response {
  return createJsonResponse({
    type: "error",
    error: {
      type,
      message,
    }
  }, status, undefined, extra);
}

/**
 * Handle Anthropic-compatible model listing responses.
 *
 * Every registered provider is listed, since a client picks the provider by
 * sending the `provider:model` prefix — a list scoped to one provider would
 * hide the rest from model pickers.
 *
 * `input_modalities` / `input_audio_formats` ride along when the serving route declares them.
 */
function handleListModels(): Response {
  const data = getAllProviders()
    .flatMap((provider) =>
      provider.getModelRegistry().listModelIds().map((modelId) => ({
        id: formatModelId(provider.id, modelId),
        display_name: modelId,
        created_at: "2024-01-01T00:00:00Z",
        type: "model",
        ...listedModalities(provider, modelId),
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
    } catch (thrown: any) {
      // Answered with the error that ended the last try; which providers were tried rides along (`FailoverError`).
      const error: any = failureOf(thrown);
      const tried = failoverHeaders(thrown);
      console.error(
        `[Anthropic] Upstream execution failed for "${ctx.resolvedModel.raw}"` +
          (tried["x-nougate-tried"] ? ` after trying ${tried["x-nougate-tried"]}:` : ":"),
        error,
      );

      // Self-describing failures answer in Anthropic's own error shape rather
      // than a flat 502, which reads to a client as "the gateway is broken".
      if (error instanceof ProviderResponseError) {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          ...tried,
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
        tried,
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
