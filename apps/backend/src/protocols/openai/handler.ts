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
import { mapOpenAIToGoogle } from "./mapper-in";
import { createOpenAIStreamTransformer } from "./mapper-out";

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
 * Finalize the upstream Google response into the current OpenAI response shape.
 */
async function finalizeOpenAIResponse(params: {
  googleRes: Response;
  openaiBody: any;
  requestId: string;
  sessionId: string;
  attempts: number;
  accountEmail: string;
}) {
  const { googleRes, openaiBody, requestId, sessionId, attempts, accountEmail } = params;
  const decoder = new TextDecoder();
  const isStreaming = openaiBody.stream === true;

  if (isStreaming) {
    if (!googleRes.body) {
      return {
        response: createJsonResponse(
          { error: { message: "No response body from upstream" } },
          502,
          attempts,
        ),
      };
    }

    const stream = googleRes.body.pipeThrough(
      createOpenAIStreamTransformer(openaiBody.model, requestId, false, sessionId),
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

  const stream = googleRes.body.pipeThrough(
    createOpenAIStreamTransformer(openaiBody.model, requestId, false, sessionId),
  );
  const reader = stream.getReader();
  let fullContent = "";
  let reasoningContent = "";
  let aggregatedToolCalls: any[] = [];
  let finalFinishReason = "stop";
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data: ") || line === "data: [DONE]") {
        continue;
      }

      try {
        const event = JSON.parse(line.slice(6));
        const choice = event.choices?.[0];
        if (!choice) {
          continue;
        }

        if (choice.delta?.content) {
          fullContent += choice.delta.content;
        }
        if (choice.delta?.reasoning_content) {
          reasoningContent += choice.delta.reasoning_content;
        }
        if (choice.delta?.tool_calls) {
          aggregatedToolCalls.push(...choice.delta.tool_calls);
        }
        if (choice.finish_reason) {
          finalFinishReason = choice.finish_reason;
        }
      } catch (error) {
        console.warn("[Stream] Failed to parse non-streaming chunk:", error);
      }
    }
  }

  if (buffer.startsWith("data: ") && buffer !== "data: [DONE]") {
    try {
      const event = JSON.parse(buffer.slice(6));
      const choice = event.choices?.[0];
      if (choice?.delta?.content) {
        fullContent += choice.delta.content;
      }
      if (choice?.delta?.reasoning_content) {
        reasoningContent += choice.delta.reasoning_content;
      }
      if (choice?.delta?.tool_calls) {
        aggregatedToolCalls.push(...choice.delta.tool_calls);
      }
      if (choice?.finish_reason) {
        finalFinishReason = choice.finish_reason;
      }
    } catch (error) {
      console.warn("[Stream] Failed to parse final non-streaming chunk:", error);
    }
  }

  if (!fullContent && aggregatedToolCalls.length === 0 && finalFinishReason !== "length") {
    console.warn(
      `[Empty] Account ${accountEmail} returned empty response for ${openaiBody.model}, retrying with another account...`,
    );
    return {
      retry: true as const,
      cooldownDuration: "30s",
    };
  }

  return {
    response: createJsonResponse(
      {
        id: requestId,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: openaiBody.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: fullContent,
              reasoning_content: reasoningContent || undefined,
              tool_calls: aggregatedToolCalls.length > 0 ? aggregatedToolCalls : undefined,
            },
            finish_reason: finalFinishReason,
          },
        ],
      },
      200,
      attempts,
    ),
  };
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
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: ctx.provider.id,
    }));

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

    const requestId = `chatcmpl-${Math.random().toString(36).substring(7)}`;
    const executor = new AntigravityExecutor();
    const result = await executor.execute({
      model: openaiBody.model,
      modelSpec,
      sessionId: ctx.sessionId,
      clientId: ctx.clientId,
      debugRequestBody: openaiBody,
      buildGoogleBody: ({ aggressive }) => {
        const providerConfig = getAntigravityConfig();
        return mapOpenAIToGoogle(openaiBody, modelSpec, ctx.sessionId, {
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
        finalizeOpenAIResponse({
          googleRes,
          openaiBody,
          requestId,
          sessionId: ctx.sessionId,
          attempts,
          accountEmail: account.email,
        }),
    });

    return result.response;
  }
}
