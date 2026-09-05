/**
 * Anthropic, reached with a credential the operator already has.
 *
 * The third kind of provider in this gateway. Antigravity and Copilot both wrap an upstream that
 * speaks somebody else's dialect and needs an OAuth client of its own; this one talks to the
 * Messages API directly, with a credential handed over whole. That removes the two largest parts of
 * a provider — the auth flow and the translation — and what is left is selection, rotation, and
 * knowing which header a credential belongs on.
 *
 * `accountFlow` is `api-key` because the dashboard's paste-a-credential form is exactly right for
 * both kinds it accepts. Which kind it *is* comes from the credential itself; see `auth/credential.ts`.
 */

import type {
  AccountRequestOptions,
  IAccount,
  IModelRegistry,
  IProvider,
  IProviderQuota,
  ProviderExecuteParams,
} from '@/core/interfaces';
import { normalizeJitterConfig, type JitterConfig } from '@/core/jitter';
import {
  getAccounts,
  getBestAccount,
  initManager,
  updateAccountUsage,
} from './auth/manager';
import type { ClaudeCodeAccount } from './auth/types';
import { claudeCodeModelRegistry } from './config/model-specs';
import { getClaudeCodeConfig, loadClaudeCodeConfig } from './config/provider-config';
import { ClaudeCodeExecutor } from './upstream/executor';
import { sanitizeAnthropicBody } from './mappers/anthropic';
import {
  createAnthropicToOpenAIStreamTransformer,
  finalizeAnthropicToOpenAIResponse,
  mapOpenAIToAnthropic,
} from './mappers/openai';

const STREAM_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  'Access-Control-Allow-Origin': '*',
};

export class ClaudeCodeProvider implements IProvider {
  readonly id = 'claude-code';
  readonly displayName = 'Claude Code';

  readonly accountFlow = 'api-key' as const;

  async init(): Promise<void> {
    await loadClaudeCodeConfig();
    await initManager();
  }

  getJitterConfig(): JitterConfig {
    return normalizeJitterConfig(getClaudeCodeConfig().features);
  }

  async getBestAccount(options: AccountRequestOptions): Promise<IAccount | null> {
    const account = await getBestAccount(options.modelId, options.excludeIds ?? []);
    return account ? this.mapAccount(account) : null;
  }

  async updateAccountUsage(
    accountId: string,
    success: boolean,
    meta: { statusCode?: number },
  ): Promise<void> {
    await updateAccountUsage(accountId, success, meta);
  }

  getAccounts(): IAccount[] {
    return getAccounts().map((account) => this.mapAccount(account));
  }

  getModelRegistry(): IModelRegistry {
    return claudeCodeModelRegistry;
  }

  getSupportedModels(): string[] {
    return claudeCodeModelRegistry.listModelIds();
  }

  async execute(params: ProviderExecuteParams): Promise<Response> {
    const { protocol, body, modelSpec, ctx } = params;
    const isStreaming = (body as { stream?: boolean }).stream === true;
    const upstreamModelId = modelSpec.upstreamModelId || modelSpec.modelId;
    const responseModelId = `claude-code:${modelSpec.modelId}`;
    const executor = new ClaudeCodeExecutor();

    if (protocol === 'anthropic') {
      // Nothing to translate. The response is handed back untouched — including the streamed one,
      // which means `cache_control`, thinking blocks and any field this gateway has never heard of
      // survive the trip in both directions.
      const result = await executor.execute({
        body: sanitizeAnthropicBody(body, upstreamModelId),
        modelSpec,
        clientId: ctx.clientId,
      });
      return result.response;
    }

    if (protocol === 'openai') {
      const result = await executor.execute({
        body: mapOpenAIToAnthropic(body, upstreamModelId, modelSpec.maxOutputTokens),
        modelSpec,
        clientId: ctx.clientId,
      });

      if (isStreaming) {
        if (!result.response.body) throw new Error('No response body from upstream Anthropic');
        return new Response(
          result.response.body.pipeThrough(createAnthropicToOpenAIStreamTransformer(responseModelId)),
          { status: 200, headers: { ...STREAM_HEADERS, 'X-Claude-Code-Attempts': String(result.attempts) } },
        );
      }

      return await finalizeAnthropicToOpenAIResponse(result.response, responseModelId);
    }

    throw new Error(`Unsupported protocol: ${protocol}`);
  }

  /**
   * Headroom, from the rate-limit headers the last response already carried.
   *
   * Reported per credential rather than merged into one figure: two credentials on different plans
   * have genuinely different ceilings, and an average would describe neither. A credential that has
   * not been used yet has no snapshot and is left out — a bar drawn at 100% for something never
   * measured is a claim, not a reading.
   */
  async getQuotas(): Promise<IProviderQuota[]> {
    return getAccounts()
      .filter((account) => account.rateLimit)
      .map((account) => {
        const limit = account.rateLimit!;
        const known = typeof limit.remaining === 'number' && typeof limit.limit === 'number' && limit.limit > 0;

        return {
          id: account.id,
          label: account.label,
          remainingFraction: known ? Math.max(0, Math.min(1, limit.remaining! / limit.limit!)) : 0,
          // Anthropic reports a rolling window rather than a plan cap, so "unlimited" is the honest
          // answer when it declined to give both numbers — not a full bar implying headroom.
          ...(known ? {} : { unlimited: true }),
          ...(typeof limit.remaining === 'number' ? { used: String(limit.remaining) } : {}),
          ...(typeof limit.limit === 'number' ? { limit: String(limit.limit) } : {}),
          unit: 'requests remaining',
          ...(limit.resetsAt ? { resetIn: formatResetIn(limit.resetsAt) } : {}),
        };
      });
  }

  /**
   * The account, with the credential removed.
   *
   * This shape reaches an HTTP response. The secret is not renamed or redacted here — it is simply
   * never copied across, because a field that is absent cannot be logged by a caller who forgot.
   */
  private mapAccount(account: ClaudeCodeAccount): IAccount {
    return {
      id: account.id,
      providerId: this.id,
      healthScore: account.healthScore,
      lastUsed: account.lastUsed,
      email: account.label,
      consecutiveFailures: account.consecutiveFailures,
      capabilities: { oauth: account.kind === 'oauth' },
      ...(account.cooldowns ? { cooldowns: account.cooldowns } : {}),
    };
  }
}

function formatResetIn(at: number): string {
  const ms = at - Date.now();
  if (ms <= 0) return 'now';
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}
