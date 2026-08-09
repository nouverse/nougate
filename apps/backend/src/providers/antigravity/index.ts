import type {
  AccountRequestOptions,
  IAccount,
  IModelRegistry,
  IProvider,
  IProviderQuota,
  ProviderExecuteParams,
} from '@/core/interfaces';
import {
  getAccounts,
  getBestAccount as getBestAntigravityAccount,
  initManager,
  updateAccountUsage as updateAntigravityAccountUsage,
  getStrategy,
  setStrategy,
  resetAllCooldowns,
  saveAccounts,
  removeAccount,
  resetAccount,
  updateAccountProject,
  markCooldown,
  addAccount,
  getCooldowns,
} from '@/providers/antigravity/auth/manager';
import type { AntigravityAccount } from '@/providers/antigravity/auth/types';
import { antigravityModelRegistry, loadModelSpecOverrides } from '@/providers/antigravity/config/model-specs';
import { supportedModelsCache, refreshAllQuotas, fetchQuota } from '@/providers/antigravity/api/quota';
import {
  getSystemInstruction,
  getAntigravityConfig,
  loadAntigravityConfig,
  saveAntigravityConfig,
  updateAntigravityConfig,
} from '@/providers/antigravity/provider-config';
import { exchangeCode, getProjectId, getUserEmail } from '@/providers/antigravity/auth/oauth';

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
 * Collapse per-account quota into one figure per limit, which is what the
 * dashboard asks for.
 *
 * Entries are matched on `limitName` and averaged: three accounts at 100%, 50%
 * and 0% leave the pool 50% full, which is what rotation will actually find.
 * The descriptive fields come from the *worst* account, so the usage and reset
 * text describe the one nearest to running out rather than an arbitrary one.
 */
export function mergeAccountQuotas(accounts: AntigravityAccount[]): IProviderQuota[] {
  type Entry = NonNullable<AntigravityAccount['quota']>[number];
  const merged = new Map<string, { sum: number; count: number; worst: Entry }>();

  for (const account of accounts) {
    for (const entry of account.quota ?? []) {
      const existing = merged.get(entry.limitName);
      if (!existing) {
        merged.set(entry.limitName, { sum: entry.remainingFraction, count: 1, worst: entry });
        continue;
      }
      existing.sum += entry.remainingFraction;
      existing.count += 1;
      if (entry.remainingFraction < existing.worst.remainingFraction) {
        existing.worst = entry;
      }
    }
  }

  return Array.from(merged.entries()).map(([limitName, entry]) => ({
    id: limitName,
    label: entry.worst.groupName,
    remainingFraction: entry.sum / entry.count,
    used: entry.worst.usage,
    limit: entry.worst.limit,
    unit: 'requests',
    resetIn: entry.worst.resetIn,
    modelIds: entry.worst.modelIds,
  }));
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

    // Start background quota refreshing
    const antigravityConfig = getAntigravityConfig();
    setInterval(refreshAllQuotas, antigravityConfig.quota.refreshIntervalMs);
    refreshAllQuotas();
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
            systemInstructionPrefix: getSystemInstruction(),
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
            systemInstructionPrefix: getSystemInstruction(),
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
      email: account.email,
      projectId: account.projectId,
      quota: account.quota,
      cooldowns: account.cooldowns,
      tokenUsage: account.tokenUsage,
      challenge: account.challenge,
      consecutiveFailures: account.consecutiveFailures,
      modelScores: account.modelScores,
    };
  }

  async getQuotas(): Promise<IProviderQuota[]> {
    return mergeAccountQuotas(getAccounts());
  }

  getStrategy(): string {
    return getStrategy();
  }

  async setStrategy(strategy: any): Promise<void> {
    setStrategy(strategy);
  }

  getConfig(): any {
    return getAntigravityConfig();
  }

  async updateConfig(updates: any): Promise<any> {
    await updateAntigravityConfig(updates);
    return getAntigravityConfig();
  }

  async resetAllAccounts(): Promise<void> {
    const accounts = getAccounts();
    for (const account of accounts) {
      account.healthScore = 100;
      account.consecutiveFailures = 0;
      account.cooldowns = {};
      account.modelScores = {};
      account.history = [];
      account.quota = [];
      delete account.challenge;
    }
    resetAllCooldowns();
    await saveAccounts(accounts);
  }

  async removeAccount(accountId: string): Promise<void> {
    await removeAccount(accountId);
  }

  async resetAccount(accountId: string): Promise<void> {
    await resetAccount(accountId);
  }

  async handleAccountAction(accountId: string, action: string, payload?: any): Promise<any> {
    switch (action) {
      case 'reset':
        return this.resetAccount(accountId);
      case 'cooldown':
        return this.markAccountCooldown(accountId, payload?.pool || 'cli', payload?.duration || '3600s');
      case 'update_project':
        if (!payload?.projectId) {
          throw new Error('Missing projectId in payload');
        }
        return updateAccountProject(accountId, payload.projectId);
      case 'rediscover_project': {
        const account = getAccounts().find((item) => item.email === accountId);
        if (!account?.accessToken) {
          throw new Error('Account not found or no token');
        }
        const projectId = await getProjectId(account.accessToken);
        if (!projectId) {
          throw new Error('No project found via discovery');
        }
        await updateAccountProject(accountId, projectId);
        return { projectId };
      }
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }

  async markAccountCooldown(accountId: string, pool: string, duration?: string): Promise<void> {
    markCooldown(accountId, (pool || "cli") as "cli" | "sandbox", duration || "3600s");
  }

  getCooldowns(): Record<string, number> {
    return getCooldowns();
  }

  async addAccount(body: any): Promise<any> {
    if (body.code) {
      const tokenRes = await exchangeCode(body.code);
      const email = await getUserEmail(tokenRes.access_token);
      const projectId = await getProjectId(tokenRes.access_token);
      const newAccount: AntigravityAccount = {
        email,
        refreshToken: tokenRes.refresh_token!,
        accessToken: tokenRes.access_token,
        expiresAt: Date.now() + tokenRes.expires_in * 1000,
        projectId,
        healthScore: 100,
        lastUsed: 0,
        tokenUsage: 0,
      };

      if (!newAccount.refreshToken) {
        throw new Error("No refresh token received. Revoke access and try again.");
      }

      if (newAccount.projectId) {
        const quota = await fetchQuota(newAccount);
        if (quota) {
          newAccount.quota = quota;
        }
      }

      await addAccount(newAccount);
      return { success: true, email };
    } else {
      return { redirectUrl: "/oauth/start" };
    }
  }
}

export {
  getSystemInstruction,
  getAntigravityConfig,
  loadAntigravityConfig,
  saveAntigravityConfig,
  updateAntigravityConfig,
};
