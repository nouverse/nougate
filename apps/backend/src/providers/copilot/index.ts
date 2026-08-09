import type {
  AccountRequestOptions,
  IAccount,
  IModelRegistry,
  IProvider,
  IProviderQuota,
  ProviderExecuteParams,
} from '@/core/interfaces';
import {
  ACCOUNT_WIDE,
  getAccounts,
  getBestAccount as getBestCopilotAccount,
  initManager,
  updateAccountUsage as updateCopilotAccountUsage,
  getStrategy,
  setStrategy,
  resetAllCooldowns,
  saveAccounts,
  removeAccount,
  resetAccount,
  markCooldown,
  addAccount as addCopilotAccount,
  getCooldowns,
} from './auth/manager';
import type { CopilotAccount } from './auth/types';
import { getPoolQuotas, invalidateQuotaCache } from './auth/quota';
import { copilotModelRegistry, loadModelSpecOverrides } from './config/model-specs';
import { getGitHubProfile } from './auth/token-exchange';
import { startDeviceFlow, pollDeviceFlow } from './auth/device-flow';
import { CopilotExecutor } from './upstream/executor';
import { loadCopilotConfig, getCopilotConfig, updateCopilotConfig } from './config/provider-config';
import { mapAnthropicToOpenAI, createOpenAIToAnthropicStreamTransformer, finalizeOpenAIToAnthropicResponse } from './mappers/anthropic';
import { createOpenAIStreamTransformer, finalizeOpenAIResponse, mapOpenAIToCopilot } from './mappers/openai';

export class CopilotProvider implements IProvider {
  readonly id = 'copilot';
  readonly displayName = 'GitHub Copilot';

  readonly accountFlow = 'device-code' as const;

  async init(): Promise<void> {
    await loadCopilotConfig();
    await loadModelSpecOverrides();
    await initManager();
  }

  async getBestAccount(options: AccountRequestOptions): Promise<IAccount | null> {
    const account = await getBestCopilotAccount(
      options.pool as 'cli' | 'sandbox' | undefined,
      options.modelId,
      options.clientId,
      options.excludeIds,
      options.skipRescue,
    );

    return account ? this.mapAccount(account) : null;
  }

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
    await updateCopilotAccountUsage(
      accountId,
      success,
      meta.modelId,
      meta.pool,
      meta.clientId,
      meta.statusCode,
    );
  }

  getAccounts(): IAccount[] {
    return getAccounts().map((account) => this.mapAccount(account));
  }

  getModelRegistry(): IModelRegistry {
    return copilotModelRegistry;
  }

  getSupportedModels(): string[] {
    return copilotModelRegistry.listModelIds();
  }

  async execute(params: ProviderExecuteParams): Promise<Response> {
    const { protocol, body, modelSpec, ctx } = params;
    const isStreaming = body.stream === true;
    const executor = new CopilotExecutor();

    if (protocol === 'openai') {
      const upstreamModelId = modelSpec.upstreamModelId || modelSpec.modelId;
      const mappedOpenAIBody = mapOpenAIToCopilot(body, upstreamModelId);

      const result = await executor.execute({
        body: mappedOpenAIBody,
        modelSpec,
        clientId: ctx.clientId,
      });

      const responseModelId = `copilot:${modelSpec.modelId}`;

      if (isStreaming) {
        if (!result.response.body) {
          throw new Error('No response body from upstream Copilot');
        }
        const transformedStream = result.response.body.pipeThrough(
          createOpenAIStreamTransformer(responseModelId)
        );
        return new Response(transformedStream, {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',
            'X-Copilot-Attempts': result.attempts.toString(),
          },
        });
      }

      return await finalizeOpenAIResponse(result.response, responseModelId);
    } else if (protocol === 'anthropic') {
      const upstreamModelId = modelSpec.upstreamModelId || modelSpec.modelId;
      const mappedOpenAIBody = mapAnthropicToOpenAI(body, upstreamModelId);

      const result = await executor.execute({
        body: mappedOpenAIBody,
        modelSpec,
        clientId: ctx.clientId,
      });

      const responseModelId = `copilot:${modelSpec.modelId}`;
      const messageId = `msg_${Math.random().toString(36).substring(2, 10)}${Math.random().toString(36).substring(2, 10)}`;

      if (isStreaming) {
        if (!result.response.body) {
          throw new Error('No response body from upstream Copilot');
        }
        const transformedStream = result.response.body.pipeThrough(
          createOpenAIToAnthropicStreamTransformer(responseModelId, messageId)
        );
        return new Response(transformedStream, {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',
            'X-Copilot-Attempts': result.attempts.toString(),
          },
        });
      }

      return await finalizeOpenAIToAnthropicResponse(result.response, responseModelId, messageId);
    } else {
      throw new Error(`Unsupported protocol: ${protocol}`);
    }
  }

  /**
   * GitHub reports quota per entitlement (chat, completions, premium requests)
   * on a monthly cycle. The mapping lives in ./auth/quota.ts.
   */
  async getQuotas(): Promise<IProviderQuota[]> {
    return getPoolQuotas(getAccounts());
  }

  getStrategy(): string {
    return getStrategy();
  }

  async setStrategy(strategy: string): Promise<void> {
    setStrategy(strategy as any);
  }

  getConfig(): any {
    return getCopilotConfig();
  }

  async updateConfig(updates: any): Promise<any> {
    await updateCopilotConfig(updates);
    return getCopilotConfig();
  }

  async resetAllAccounts(): Promise<void> {
    resetAllCooldowns();
  }

  async removeAccount(accountId: string): Promise<void> {
    await removeAccount(accountId);
    // Its cached quota would otherwise keep counting toward the pool.
    invalidateQuotaCache(accountId);
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
      default:
        throw new Error(`Action "${action}" not supported for Copilot provider`);
    }
  }

  async markAccountCooldown(accountId: string, pool: string, duration?: string): Promise<void> {
    // Manual cooldown benches the whole account, not one model.
    markCooldown(accountId, pool as any, ACCOUNT_WIDE, duration, 'rate_limited');
  }

  getCooldowns(): Record<string, number> {
    return getCooldowns();
  }

  async addAccount(body: any): Promise<any> {
    if (!body || Object.keys(body).length === 0) {
      const deviceFlow = await startDeviceFlow();
      return {
        step: 'device_flow',
        ...deviceFlow,
      };
    }

    if (body.personalToken) {
      const profile = await getGitHubProfile(body.personalToken);
      const id = profile.login;
      
      const account: CopilotAccount = {
        id,
        providerId: 'copilot',
        personalToken: body.personalToken,
        githubUsername: profile.login,
        email: profile.email || undefined,
        healthScore: 100,
        lastUsed: Date.now(),
        status: 'active',
      };

      await addCopilotAccount(account);
      return this.mapAccount(account);
    }

    throw new Error('Invalid request body. Expected empty body to start device flow or personalToken for manual add.');
  }

  async completeDeviceFlow(deviceCode: string): Promise<any> {
    const result = await pollDeviceFlow(deviceCode);
    if ('error' in result) {
      return {
        status: 'pending',
        error: result.error,
      };
    }

    const profile = await getGitHubProfile(result.access_token);
    const id = profile.login;

    const account: CopilotAccount = {
      id,
      providerId: 'copilot',
      personalToken: result.access_token,
      githubUsername: profile.login,
      email: profile.email || undefined,
      healthScore: 100,
      lastUsed: Date.now(),
      status: 'active',
    };

    await addCopilotAccount(account);
    return {
      status: 'success',
      account: this.mapAccount(account),
    };
  }

  private mapAccount(account: CopilotAccount): IAccount {
    return {
      id: account.id,
      providerId: account.providerId,
      healthScore: account.healthScore,
      lastUsed: account.lastUsed,
      capabilities: account.capabilities,
      email: account.email || account.githubUsername || account.id,
      cooldowns: account.cooldowns,
      tokenUsage: account.tokenUsage,
      consecutiveFailures: account.consecutiveFailures,
      modelScores: account.modelScores,
    };
  }
}
