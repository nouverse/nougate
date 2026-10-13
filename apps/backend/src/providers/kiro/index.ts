/**
 * Kiro (AWS CodeWhisperer) provider.
 *
 * Kiro speaks neither dialect that reaches this gateway: requests are `GenerateAssistantResponse`
 * conversation states, and answers are AWS EventStream binary frames. Both client dialects are
 * mapped to and from that directly (`mappers/openai.ts`, `mappers/anthropic.ts`), and the answer is
 * streamed as it decodes.
 *
 * Accounts come from an AWS SSO device login (Builder ID or IAM Identity Center) or a pasted
 * credential — a desktop refresh token, an API key, or an enterprise token set. See `auth/`.
 */

import type {
  AccountRequestOptions,
  DeviceFlowPollResult,
  IAccount,
  IModelRegistry,
  IProvider,
  IProviderQuota,
  ProviderExecuteParams,
} from '@/core/interfaces';
import { normalizeJitterConfig, type JitterConfig } from '@/core/jitter';
import { ACCOUNT_WIDE, initKiroAccounts, kiroAccounts, type NewKiroAccount } from './auth/manager';
import { pollDeviceFlow, startDeviceFlow } from './auth/device-flow';
import { fetchModelCatalog, fetchProfileArn } from './auth/profile';
import { fetchUsageLimits, getPoolQuotas, invalidateQuotaCache } from './auth/quota';
import { importToken } from './auth/token-import';
import type { KiroAccount, SelectionStrategy } from './auth/types';
import { catalogToModelDefs, kiroModelRegistry } from './config/model-specs';
import { getKiroConfig, loadKiroConfig, updateKiroConfig, type KiroConfig } from './config/provider-config';
import { AnthropicStreamEncoder, buildAnthropicMessage, convertAnthropicMessages, extractSystemText, newMessageId } from './mappers/anthropic';
import { OpenAIStreamEncoder, buildOpenAICompletion, convertOpenAIMessages } from './mappers/openai';
import { prepareKiroRequest } from './mappers/payload';
import { collectKiroEvents, streamKiroResponse } from './mappers/response';
import { KiroExecutor, ensureFreshCredential } from './upstream/executor';

const HOUR_MS = 3_600_000;

export class KiroProvider implements IProvider {
  readonly id = 'kiro';
  readonly displayName = 'Kiro AI';
  readonly accountFlow = 'device-code' as const;

  async init(): Promise<void> {
    await loadKiroConfig();
    await initKiroAccounts();
    // In the background: boot must not wait on AWS, and the static catalogue serves meanwhile.
    void this.refreshModelCatalog();
  }

  getJitterConfig(): JitterConfig {
    return normalizeJitterConfig(getKiroConfig().features);
  }

  async getBestAccount(options: AccountRequestOptions): Promise<IAccount | null> {
    const account = kiroAccounts.best({ modelId: options.modelId, excludeIds: options.excludeIds, clientId: options.clientId });
    return account ? this.mapAccount(account) : null;
  }

  async updateAccountUsage(accountId: string, success: boolean, meta: { modelId?: string; statusCode?: number; clientId?: string }): Promise<void> {
    kiroAccounts.recordResult(accountId, success, { modelId: meta.modelId, status: meta.statusCode, clientId: meta.clientId });
  }

  getAccounts(): IAccount[] {
    return kiroAccounts.list().map((account) => this.mapAccount(account));
  }

  getModelRegistry(): IModelRegistry {
    return kiroModelRegistry;
  }

  getSupportedModels(): string[] {
    return kiroModelRegistry.listModelIds();
  }

  async execute(params: ProviderExecuteParams): Promise<Response> {
    const { protocol, body, modelSpec, resolvedModel, ctx } = params;
    const isStreaming = body?.stream === true;
    const responseModelId = `kiro:${modelSpec.modelId}`;
    const images = modelSpec.inputModalities?.includes('image') ?? false;
    // `resolvedModel.modelId` still carries a `(level)` override that the spec lookup stripped.
    const requestedModel = resolvedModel.modelId || modelSpec.modelId;

    const prepared =
      protocol === 'anthropic'
        ? prepareKiroRequest({
            requestedModel,
            body,
            headers: ctx.req.headers,
            tools: body?.tools,
            systemText: extractSystemText(body?.system),
            maxTokens: body?.max_tokens,
            convert: (model) => convertAnthropicMessages(body?.messages, model, { images }),
          })
        : prepareKiroRequest({
            requestedModel,
            body,
            headers: ctx.req.headers,
            tools: body?.tools,
            // OpenAI system messages are inlined into the turns as <instructions>.
            systemText: '',
            maxTokens: body?.max_completion_tokens ?? body?.max_tokens,
            convert: (model) => convertOpenAIMessages(body?.messages, model, { images }),
          });

    const result = await new KiroExecutor().execute({
      prepared,
      modelSpec,
      clientId: ctx.clientId,
      signal: ctx.req.signal,
    });
    const attemptsHeader = { 'X-Kiro-Attempts': String(result.attempts) };

    if (isStreaming) {
      const encoder =
        protocol === 'anthropic' ? new AnthropicStreamEncoder(responseModelId) : new OpenAIStreamEncoder(responseModelId);
      return streamKiroResponse(result.reader, result.primed, encoder, attemptsHeader);
    }

    const { events, error } = await collectKiroEvents(result.reader, result.primed);
    if (error) {
      const payload =
        protocol === 'anthropic'
          ? { type: 'error', error: { type: 'api_error', message: error.message, code: error.code } }
          : { error: { message: error.message, type: 'upstream_error', code: error.code } };
      return Response.json(payload, { status: error.status >= 400 ? error.status : 502, headers: attemptsHeader });
    }
    const message =
      protocol === 'anthropic'
        ? buildAnthropicMessage(events, responseModelId, newMessageId())
        : buildOpenAICompletion(events, responseModelId);
    return Response.json(message, { headers: attemptsHeader });
  }

  // ─── Quota ───────────────────────────────────────────────────────────────

  async getQuotas(): Promise<IProviderQuota[]> {
    // Quota calls fail on an expired token like anything else; renew the ones that need it first.
    await Promise.all(kiroAccounts.list().map((account) => ensureFreshCredential(account).catch(() => 'ok')));
    return getPoolQuotas(kiroAccounts.list());
  }

  // ─── Accounts ────────────────────────────────────────────────────────────

  /**
   * - `{}`                     — start an AWS Builder ID device login.
   * - `{ startUrl, region? }`  — start an IAM Identity Center device login.
   * - `{ token, region?, label? }` — import a pasted refresh token, API key or token-set JSON.
   */
  async addAccount(body: any): Promise<any> {
    if (typeof body?.token === 'string' && body.token.trim()) {
      const account = await this.store(await importToken(body));
      return this.mapAccount(account);
    }
    return startDeviceFlow({ startUrl: body?.startUrl, region: body?.region });
  }

  /** Polled by the dashboard while the operator approves the code in their browser. */
  async completeDeviceFlow(deviceCode: string): Promise<DeviceFlowPollResult> {
    const result = await pollDeviceFlow(deviceCode);
    if (result.status !== 'success') return { status: result.status, error: result.error };

    const { login, tokens } = result;
    const account = await this.store({
      authMethod: login.authMethod,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: Date.now() + (tokens.expiresIn ?? 3600) * 1000,
      region: login.region,
      clientId: login.clientId,
      clientSecret: login.clientSecret,
      ...(login.clientSecretExpiresAt ? { clientSecretExpiresAt: login.clientSecretExpiresAt } : {}),
      ...(login.authMethod === 'idc' ? { startUrl: login.startUrl } : {}),
    });
    return { status: 'success', account: this.mapAccount(account) };
  }

  /**
   * Fill in what a fresh credential does not carry — its profile and its email — then store it.
   * Both lookups are best-effort: an account that cannot answer them still works for chat.
   */
  private async store(input: NewKiroAccount): Promise<KiroAccount> {
    const enriched: NewKiroAccount = { ...input };
    if (!enriched.profileArn && enriched.authMethod !== 'api_key') {
      const arn = await fetchProfileArn(enriched).catch((error: Error) => {
        console.warn(`[kiro] could not resolve a profile for the new account: ${error.message}`);
        return null;
      });
      if (arn) enriched.profileArn = arn;
    }
    if (!enriched.email) {
      const limits = await fetchUsageLimits(enriched).catch(() => null);
      const email = limits?.userInfo?.email;
      if (email) enriched.email = email;
    }
    const account = kiroAccounts.upsert(enriched);
    invalidateQuotaCache(account.id);
    void this.refreshModelCatalog();
    return account;
  }

  /** Offer models the live catalogue reports that the static list does not know. */
  private async refreshModelCatalog(): Promise<void> {
    if (!getKiroConfig().features.liveModelCatalog) return;
    const account = kiroAccounts.best();
    if (!account) return;
    try {
      const added = kiroModelRegistry.mergeLive(catalogToModelDefs(await fetchModelCatalog(account)));
      if (added > 0) console.log(`[kiro] live catalogue added ${added} model(s)`);
    } catch (error) {
      console.warn(`[kiro] could not read the live model catalogue: ${(error as Error).message.slice(0, 200)}`);
    }
  }

  async removeAccount(accountId: string): Promise<void> {
    if (!kiroAccounts.remove(accountId)) throw new Error(`no account matches "${accountId}"`);
    invalidateQuotaCache(accountId);
  }

  async resetAccount(accountId: string): Promise<void> {
    if (!kiroAccounts.reset(accountId)) throw new Error(`no account matches "${accountId}"`);
  }

  async resetAllAccounts(): Promise<void> {
    kiroAccounts.resetAll();
  }

  async markAccountCooldown(accountId: string, _pool: string, duration?: string): Promise<void> {
    if (!kiroAccounts.markCooldown(accountId, ACCOUNT_WIDE, parseDurationMs(duration) ?? HOUR_MS)) {
      throw new Error(`no account matches "${accountId}"`);
    }
  }

  getCooldowns(): Record<string, number> {
    return kiroAccounts.cooldowns();
  }

  async handleAccountAction(accountId: string, action: string, payload?: any): Promise<any> {
    switch (action) {
      case 'reset':
        await this.resetAccount(accountId);
        return { ok: true };
      case 'cooldown':
        await this.markAccountCooldown(accountId, payload?.pool ?? 'cli', payload?.duration);
        return { ok: true };
      default:
        throw new Error(`Action "${action}" is not supported by the Kiro provider`);
    }
  }

  getStrategy(): string {
    return kiroAccounts.getStrategy();
  }

  async setStrategy(strategy: string): Promise<void> {
    if (strategy !== 'healthiest' && strategy !== 'round-robin') {
      throw new Error(`Unknown strategy "${strategy}" — use "healthiest" or "round-robin"`);
    }
    kiroAccounts.setStrategy(strategy as SelectionStrategy);
  }

  getConfig(): KiroConfig {
    return getKiroConfig();
  }

  async updateConfig(updates: Partial<KiroConfig>): Promise<KiroConfig> {
    return updateKiroConfig(updates);
  }

  private mapAccount(account: KiroAccount): IAccount {
    return toPublicAccount(account);
  }
}

/** What the dashboard sees. Never a token: only the label, which is an email or a fingerprint. */
export function toPublicAccount(account: KiroAccount): IAccount {
  return {
    id: account.id,
    providerId: 'kiro',
    healthScore: account.healthScore,
    lastUsed: account.lastUsed,
    email: account.label,
    consecutiveFailures: account.consecutiveFailures,
    capabilities: {
      [account.authMethod]: true,
      ...(account.invalidatedAt ? { invalid: true } : {}),
    },
    ...(account.cooldowns ? { cooldowns: account.cooldowns } : {}),
    ...(account.modelScores ? { modelScores: account.modelScores } : {}),
  };
}

function parseDurationMs(duration?: string): number | undefined {
  if (!duration) return undefined;
  const match = /^(\d+)(ms|s|m|h)?$/.exec(duration.trim());
  if (!match) return undefined;
  const value = Number(match[1]);
  const unit = match[2] ?? 's';
  return value * (unit === 'ms' ? 1 : unit === 's' ? 1_000 : unit === 'm' ? 60_000 : HOUR_MS);
}
