import { formatModelId } from "@/core/model-resolver";
import { listedSpec } from "@/core/model-listing";
import type { IProtocolHandler } from "@/core/interfaces";
import { ProviderResponseError } from "@/core/upstream-errors";
import type { RequestContext } from "@/core/request-context";
import { getAllProviders } from "@/core/registry";
import { prepareRequestPayload } from "@/core/metrics/compression";
import { instrumentResponse } from "@/core/metrics/tracker";
import { executeWithFailover, failoverHeaders, failureOf } from "@/core/provider-execute";
import { noCandidate, routeCandidates } from "@/core/smart-routing";

/**
 * Build a JSON response with the shared OpenAI proxy headers, and any of its own.
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
 * The request's conversation as an id, the same on each of its requests: who is asking, and how it opened.
 *
 * Who: `user` on the OpenAI wire, `metadata.user_id` on the Anthropic one, else the client. How it opened: the first
 * message's first block, without its cache marker. Not the whole first message: a client adds to its newest message
 * (Nouride's work notes) and moves its cache markers to the newest messages, and at a conversation's first request
 * the newest message is the first. Hashed whole, a conversation's second request had an id of its own (live on
 * 2026-11-05: two requests in a row, two ids, the second reading the first's cache). The account a conversation is
 * kept on (`core/conversation-accounts.ts`) and Antigravity's signature cache are keyed by it. With no first message
 * there is no conversation to name: a random id.
 */
export function buildSessionId(body: any, clientId: string): string {
  const content = body.messages?.[0]?.content;
  const opening = Array.isArray(content) ? content[0] : content;
  if (!opening) return crypto.randomUUID();

  const said = typeof opening === "string" ? opening : JSON.stringify({ ...opening, cache_control: undefined });
  const who = body.user || body.metadata?.user_id || clientId;
  return new Bun.CryptoHasher("sha256").update(`${who}:${said}`).digest("hex");
}

/**
 * Handle OpenAI-compatible model listing responses.
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
        legacy_id: `${provider.id}-${modelId}`,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: provider.id,
        provider: provider.id,
        ...listedSpec(provider, modelId),
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
/**
 * A failure that knows how the client should be answered, in OpenAI's error shape. Labelled by status: a client reads
 * the label before the status, and a server's failure labelled `invalid_request_error` read as a request built wrong
 * — Nouride told the person so, and did not retry (nouride-releases#14). A credential the gateway lacks is neither
 * the request's fault nor the server's.
 */
function describedFailure(error: ProviderResponseError, extra: Record<string, string> = {}): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    ...extra,
  };
  if (error.retryAfterSeconds) headers["Retry-After"] = String(error.retryAfterSeconds);
  const type =
    error.status === 401 ? "authentication_error" : error.status === 429 ? "rate_limit_error" : error.status >= 500 ? "server_error" : "invalid_request_error";
  return new Response(JSON.stringify({ error: { message: error.message, type, code: error.clientCode } }), { status: error.status, headers });
}

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

    // An unprefixed model fans out across every provider that declares it; a prefixed one resolves
    // to exactly that provider. Either way what comes back is an ordered list, so the two cases
    // share one execution path — see `core/smart-routing`.
    const candidates = routeCandidates(ctx.resolvedModel);
    if (candidates.length === 0) return describedFailure(noCandidate(ctx.resolvedModel));

    const startedAt = Date.now();

    // RTK (inline tool-result compression) then Headroom (semantic compression)
    const { body: compressedBody, compression } = await prepareRequestPayload(openaiBody);

    // Delegate upstream execution dynamically to the resolved provider.
    // A throw here (no usable account, upstream unreachable, exhausted retries)
    // must still reach the client as a protocol-shaped JSON error rather than
    // escaping into the server's default HTML error page.
    let served;
    try {
      served = await executeWithFailover(candidates, (candidate) => ({
        protocol: "openai",
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
        `[OpenAI] Upstream execution failed for "${ctx.resolvedModel.raw}"` +
          (tried["x-nougate-tried"] ? ` after trying ${tried["x-nougate-tried"]}:` : ":"),
        error,
      );

      // A provider that already knows how the client should be answered says
      // so. Everything else becomes a 502, which reads as "the gateway broke".
      if (error instanceof ProviderResponseError) return describedFailure(error, tried);

      return createJsonResponse(
        {
          error: {
            message: error?.message || "Upstream request failed",
            type: "api_error",
            code: "upstream_error",
          },
        },
        502,
        undefined,
        tried,
      );
    }

    // The provider that *served*, not the one that was picked first — otherwise a failed-over
    // request bills the provider that refused it.
    return instrumentResponse(served.response, {
      provider: served.provider.id,
      model: served.modelSpec.modelId,
      protocol: "openai",
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
