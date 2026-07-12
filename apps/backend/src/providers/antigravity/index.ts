import type {
  AccountRequestOptions,
  IAccount,
  IModelRegistry,
  IProvider,
  ProviderExecuteParams,
} from '@/core/interfaces';
import {
  getAccounts,
  getBestAccount as getBestAntigravityAccount,
  initManager,
  updateAccountUsage as updateAntigravityAccountUsage,
} from '@/providers/antigravity/auth/manager';
import type { AntigravityAccount } from '@/providers/antigravity/auth/types';
import { antigravityModelRegistry, loadModelSpecOverrides } from '@/providers/antigravity/config/model-specs';
import { supportedModelsCache } from '@/providers/antigravity/api/quota';
import {
  ANTIGRAVITY_SYSTEM_INSTRUCTION,
  getAntigravityConfig,
  loadAntigravityConfig,
  saveAntigravityConfig,
  updateAntigravityConfig,
} from '@/providers/antigravity/provider-config';

import { AntigravityExecutor } from '@/providers/antigravity/upstream/executor';
import { mapOpenAIToGoogle } from '@/providers/antigravity/mappers/openai-in';
import { createOpenAIStreamTransformer } from '@/providers/antigravity/mappers/openai-out';
import { mapAnthropicToGoogle } from '@/providers/antigravity/mappers/anthropic-in';
import { createAnthropicStreamTransformer, aggregateAnthropicResponse } from '@/providers/antigravity/mappers/anthropic-out';
import { checkSessionSignatureRewind } from '@/providers/antigravity/utils/signature-cache';

// Helper to build OpenAI/Anthropic responses
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

function createAnthropicErrorResponse(message: string, type = "invalid_request_error", status = 400): Response {
  return createJsonResponse({
    type: "error",
    error: {
      type,
      message,
    }
  }, status);
}

async function finalizeOpenAIResponse(params: {
  googleRes: Response;
  openaiBody: any;
  requestId: string;
  sessionId: string;
  attempts: number;
  accountEmail: string;
  messageCount: number;
  assistantTurnIndex: number;
}) {
  const { googleRes, openaiBody, requestId, sessionId, attempts, accountEmail, messageCount, assistantTurnIndex } = params;
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
      createOpenAIStreamTransformer(openaiBody.model, requestId, false, sessionId, messageCount, assistantTurnIndex),
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
    createOpenAIStreamTransformer(openaiBody.model, requestId, false, sessionId, messageCount, assistantTurnIndex),
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

async function finalizeAnthropicResponse(params: {
  googleRes: Response;
  anthropicBody: any;
  messageId: string;
  sessionId: string;
  attempts: number;
  accountEmail: string;
  messageCount: number;
  assistantTurnIndex: number;
}) {
  const { googleRes, anthropicBody, messageId, sessionId, attempts, accountEmail, messageCount, assistantTurnIndex } = params;
  const isStreaming = anthropicBody.stream === true;

  if (isStreaming) {
    if (!googleRes.body) {
      return {
        response: createAnthropicErrorResponse("No response body from upstream", "api_error", 502),
      };
    }

    const stream = googleRes.body.pipeThrough(
      createAnthropicStreamTransformer(anthropicBody.model, messageId, sessionId, messageCount, assistantTurnIndex),
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
    messageCount,
    assistantTurnIndex,
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
 * Concrete provider implementation for Antigravity accounts and model registry.
 */
export class AntigravityProvider implements IProvider {
  readonly id = 'antigravity';

  readonly displayName = 'Antigravity';

  /**
   * Initialize provider-owned config, runtime model overrides, and account state.
   */
  async init(): Promise<void> {
    await loadAntigravityConfig();
    await loadModelSpecOverrides();
    await initManager();
  }

  /**
   * Select the best available account for the given routing constraints.
   */
  async getBestAccount(options: AccountRequestOptions): Promise<IAccount | null> {
    const account = await getBestAntigravityAccount(
      options.pool as 'cli' | 'sandbox' | undefined,
      options.modelId,
      options.clientId,
      options.excludeIds,
      options.skipRescue,
    );

    return account ? this.mapAccount(account) : null;
  }

  /**
   * Forward usage updates to the provider-local account manager.
   */
  async updateAccountUsage(
    accountId: string,
    success: boolean,
    meta: {
      modelId?: string;
      pool?: string;
      clientId?: string;
      statusCode?: number;
    },
  ): Promise<void> {
    await updateAntigravityAccountUsage(
      accountId,
      success,
      meta.modelId,
      meta.pool,
      meta.clientId,
      meta.statusCode,
    );
  }

  /**
   * Return the current provider accounts in the shared registry shape.
   */
  getAccounts(): IAccount[] {
    return getAccounts().map((account) => this.mapAccount(account));
  }

  /**
   * Return the provider-local model registry.
   */
  getModelRegistry(): IModelRegistry {
    return antigravityModelRegistry;
  }

  /**
   * Return the supported model IDs from quota cache.
   */
  getSupportedModels(): string[] {
    return Array.from(supportedModelsCache);
  }

  /**
   * Route execution through AntigravityUpstream mapping, rotation, retry, and caching.
   */
  async execute(params: ProviderExecuteParams): Promise<Response> {
    const { protocol, body, modelSpec, ctx } = params;

    if (protocol === 'openai') {
      const currentMessageCount = body.messages?.length || 0;
      const assistantTurnIndex = body.messages?.filter((m: any) => m.role === "assistant").length || 0;
      checkSessionSignatureRewind(ctx.sessionId, currentMessageCount);

      const requestId = `chatcmpl-${Math.random().toString(36).substring(7)}`;
      const executor = new AntigravityExecutor();
      
      const result = await executor.execute({
        model: body.model,
        modelSpec,
        sessionId: ctx.sessionId,
        clientId: ctx.clientId,
        debugRequestBody: body,
        buildGoogleBody: ({ aggressive }) => {
          const providerConfig = getAntigravityConfig();
          return mapOpenAIToGoogle(body, modelSpec, ctx.sessionId, {
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
            openaiBody: body,
            requestId,
            sessionId: ctx.sessionId,
            attempts,
            accountEmail: account.email,
            messageCount: currentMessageCount,
            assistantTurnIndex,
          }),
      });

      return result.response;
    } else if (protocol === 'anthropic') {
      const currentMessageCount = body.messages?.length || 0;
      const assistantTurnIndex = body.messages?.filter((m: any) => m.role === "assistant").length || 0;
      checkSessionSignatureRewind(ctx.sessionId, currentMessageCount);

      const messageId = `msg_${Math.random().toString(36).substring(2, 10)}${Math.random().toString(36).substring(2, 10)}`;
      const executor = new AntigravityExecutor();

      const result = await executor.execute({
        model: body.model,
        modelSpec,
        sessionId: ctx.sessionId,
        clientId: ctx.clientId,
        debugRequestBody: body,
        buildGoogleBody: ({ aggressive }) => {
          const providerConfig = getAntigravityConfig();
          return mapAnthropicToGoogle(body, modelSpec, ctx.sessionId, {
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
            anthropicBody: body,
            messageId,
            sessionId: ctx.sessionId,
            attempts,
            accountEmail: account.email,
            messageCount: currentMessageCount,
            assistantTurnIndex,
          }),
      });

      return result.response;
    } else {
      throw new Error(`Unsupported protocol: ${protocol}`);
    }
  }

  /**
   * Convert an Antigravity account into the shared provider interface.
   */
  private mapAccount(account: AntigravityAccount): IAccount {
    return {
      id: account.email,
      providerId: this.id,
      healthScore: account.healthScore,
      lastUsed: account.lastUsed,
      capabilities: account.capabilities,
    };
  }
}

export {
  ANTIGRAVITY_SYSTEM_INSTRUCTION,
  getAntigravityConfig,
  loadAntigravityConfig,
  saveAntigravityConfig,
  updateAntigravityConfig,
};
