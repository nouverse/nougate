/**
 * Codex (OpenAI) provider — subscription-backed OAuth, Responses API format.
 *
 * Talks to `chatgpt.com/backend-api/codex/responses` with OAuth tokens from `auth.openai.com`.
 * The protocol is `openai-responses` (NOT standard OpenAI Chat Completions).
 *
 * Key differences from Claude Code:
 * - OAuth with form-encoded refresh, fixedPort 1455, extraParams, PKCE S256
 * - Responses API format (not Anthropic Messages)
 * - Auth: `Authorization: Bearer {accessToken}` + `ChatGPT-Account-ID` header
 * - SSE peek/retry for errors hidden inside 200 OK bodies
 * - Proactive stale refresh via maxRefreshAgeMs (8 days)
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
  addOAuthAccount,
  cooldownScope,
  getAccounts,
  getBestAccount,
  initManager,
  markCooldown,
  removeAccount,
  resetAccount,
  updateAccountUsage,
} from './auth/manager';
import { beginAuthorization, CODEX_OAUTH, exchangeCode } from './auth/oauth';
import type { CodexAccount } from './auth/types';
import { codexModelRegistry } from './config/model-specs';
import {
  getCodexConfig,
  loadCodexConfig,
  updateCodexConfig,
  type CodexConfig,
} from './config/provider-config';
import { CodexExecutor } from './upstream/executor';
import { getCodexUsage, usageToQuotas } from './api/usage';
import {
  createResponsesToOpenAIStreamTransformer,
  finalizeResponsesToOpenAIResponse,
  mapOpenAIToResponses,
} from './mappers/openai-to-responses';
import {
  createOpenAIToAnthropicStreamTransformer,
  finalizeOpenAIToAnthropicResponse,
  mapAnthropicToOpenAI,
} from '@/core/mappers/anthropic-to-openai';

const HOUR_MS = 3_600_000;

const STREAM_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'Access-Control-Allow-Origin': '*',
  'X-Accel-Buffering': 'no',
};

/**
 * The redirect URI for Codex OAuth.
 *
 * Codex CLI's client_id is bound to fixedPort 1455 with callbackPath `/auth/callback`.
 * Must be `http://localhost:1455/auth/callback` — matching 9router exactly.
 */
function getCodexCallbackUri(): string {
  return `http://localhost:${CODEX_OAUTH.fixedPort}${CODEX_OAUTH.callbackPath}`;
}

export class CodexProvider implements IProvider {
  readonly id = 'codex';
  readonly displayName = 'OpenAI Codex';

  readonly accountFlow = 'oauth-redirect' as const;

  private pending: { url: string; state: string; codeVerifier: string; redirectUri: string } | null =
    null;

  async init(): Promise<void> {
    await loadCodexConfig();
    await initManager();
  }

  getJitterConfig(): JitterConfig {
    return normalizeJitterConfig(getCodexConfig().features);
  }

  async getBestAccount(options: AccountRequestOptions): Promise<IAccount | null> {
    const account = await getBestAccount(options.modelId, options.excludeIds ?? []);
    return account ? this.mapAccount(account) : null;
  }

  async updateAccountUsage(accountId: string, success: boolean): Promise<void> {
    await updateAccountUsage(accountId, success);
  }

  getAccounts(): IAccount[] {
    return getAccounts().map((account) => this.mapAccount(account));
  }

  getModelRegistry(): IModelRegistry {
    return codexModelRegistry;
  }

  getSupportedModels(): string[] {
    return codexModelRegistry.listModelIds();
  }

  /**
   * One request, translated in and out of the Responses API.
   *
   * Codex speaks neither dialect that reaches this gateway, and it has no non-streaming mode — the
   * upstream rejects `stream: false` — so `stream` is read from the caller here and the answer is
   * either piped or collected, never passed through. Two branches rather than one because the
   * Anthropic side is Chat Completions with a translation on each end; the Responses part of the
   * work is the same code both times.
   *
   * TODO: a native `/codex/v1/responses` route. `ProtocolId` already carries `'codex'`, and a client
   * that speaks Responses natively should not be translated to Chat Completions and back to reach an
   * upstream that wanted Responses in the first place.
   */
  async execute(params: ProviderExecuteParams): Promise<Response> {
    const { protocol, body, modelSpec, ctx } = params;
    const isStreaming = (body as { stream?: boolean })?.stream === true;
    const upstreamModelId = modelSpec.upstreamModelId || modelSpec.modelId;
    const responseModelId = `codex:${modelSpec.modelId}`;
    const executor = new CodexExecutor();

    if (protocol === 'anthropic') {
      const messageId = `msg_${Date.now().toString(36)}`;
      const chatBody = mapAnthropicToOpenAI(body, upstreamModelId);

      const result = await executor.execute({
        body: mapOpenAIToResponses(chatBody, upstreamModelId),
        modelSpec,
        clientId: ctx.clientId,
      });

      if (isStreaming) {
        if (!result.response.body) throw new Error('No response body from upstream Codex');
        return new Response(
          result.response.body
            .pipeThrough(createResponsesToOpenAIStreamTransformer(responseModelId))
            .pipeThrough(createOpenAIToAnthropicStreamTransformer(responseModelId, messageId)),
          { status: 200, headers: STREAM_HEADERS },
        );
      }

      const asChat = await finalizeResponsesToOpenAIResponse(result.response, responseModelId);
      return await finalizeOpenAIToAnthropicResponse(asChat, responseModelId, messageId);
    }

    const result = await executor.execute({
      body: mapOpenAIToResponses(body, upstreamModelId),
      modelSpec,
      clientId: ctx.clientId,
    });

    if (isStreaming) {
      if (!result.response.body) throw new Error('No response body from upstream Codex');
      return new Response(
        result.response.body.pipeThrough(createResponsesToOpenAIStreamTransformer(responseModelId)),
        { status: 200, headers: STREAM_HEADERS },
      );
    }

    return await finalizeResponsesToOpenAIResponse(result.response, responseModelId);
  }

  async getQuotas(): Promise<IProviderQuota[]> {
    const accounts = getAccounts().filter((account) => !account.invalidatedAt);

    const reported = await Promise.all(
      accounts.map(async (account) => {
        try {
          const usage = await getCodexUsage(account.accessToken);
          if (!usage) return [];
          return usageToQuotas(account.id, account.label, usage);
        } catch (error) {
          console.warn(
            `[codex] usage lookup failed for ${account.label}: ${String(error).slice(0, 200)}`,
          );
          return [];
        }
      }),
    );

    return reported.flat();
  }

  /**
   * Add a Codex account via OAuth flow.
   *
   * - `{}`               — begin OAuth. Returns the URL to open.
   * - `{ code, state }`  — finish OAuth. Exchanges code for tokens.
   */
  async addAccount(body: {
    code?: string;
    state?: string;
    label?: string;
    redirectUri?: string;
  }): Promise<unknown> {
    if (body?.code) {
      const pending = this.pending;
      if (!pending) {
        console.error('[codex] addAccount({ code }) called but no pending authorization exists');
        throw Object.assign(new Error('Start the sign-in again — no authorization is in progress.'), {
          status: 409,
        });
      }
      console.log(`[codex] exchanging code (${body.code.slice(0, 8)}…) with redirect_uri=${pending.redirectUri}`);
      try {
        const tokens = await exchangeCode(body.code, pending.redirectUri, pending.codeVerifier);
        this.pending = null;

        const account = await addOAuthAccount({
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token ?? '',
          idToken: tokens.id_token,
          ...(tokens.expires_in ? { expiresInSeconds: tokens.expires_in } : {}),
          ...(body.label ? { label: body.label } : {}),
        });
        console.log(`[codex] account added: ${account.label}`);
        return { success: true, email: account.label };
      } catch (err: any) {
        console.error(`[codex] token exchange failed:`, err?.message || err);
        throw err;
      }
    }

    const redirectUri = body?.redirectUri || getCodexCallbackUri();
    const started = beginAuthorization(redirectUri);
    this.pending = { ...started, redirectUri };
    return { redirectUrl: started.url, state: started.state };
  }

  getConfig(): CodexConfig {
    return getCodexConfig();
  }

  async updateConfig(updates: Partial<CodexConfig>): Promise<CodexConfig> {
    return updateCodexConfig(updates);
  }

  async removeAccount(accountId: string): Promise<void> {
    const removed = await removeAccount(accountId);
    if (!removed) throw new Error(`no account matches "${accountId}"`);
  }

  async resetAccount(accountId: string): Promise<void> {
    const reset = await resetAccount(accountId);
    if (!reset) throw new Error(`no account matches "${accountId}"`);
  }

  async markAccountCooldown(accountId: string, _pool: string, duration?: string): Promise<void> {
    const marked = await markCooldown(accountId, cooldownScope(), parseDurationMs(duration) ?? HOUR_MS);
    if (!marked) throw new Error(`no account matches "${accountId}"`);
  }

  async handleAccountAction(accountId: string, action: string, payload?: any): Promise<any> {
    switch (action) {
      case 'reset':
        await this.resetAccount(accountId);
        return { ok: true };
      case 'cooldown':
        await this.markAccountCooldown(accountId, payload?.pool ?? 'account', payload?.duration);
        return { ok: true };
      default:
        throw new Error(`Action "${action}" is not supported by the Codex provider`);
    }
  }

  private mapAccount(account: CodexAccount): IAccount {
    return {
      id: account.id,
      providerId: this.id,
      healthScore: account.healthScore,
      lastUsed: account.lastUsed,
      email: account.label,
      consecutiveFailures: account.consecutiveFailures,
      capabilities: { oauth: true },
      ...(account.cooldowns ? { cooldowns: account.cooldowns } : {}),
    };
  }
}

function parseDurationMs(duration?: string): number | undefined {
  if (!duration) return undefined;
  const match = /^(\d+)(ms|s|m|h)?$/.exec(duration.trim());
  if (!match) return undefined;
  const value = Number(match[1]);
  const unit = match[2] ?? 's';
  const scale = unit === 'ms' ? 1 : unit === 's' ? 1_000 : unit === 'm' ? 60_000 : HOUR_MS;
  return value * scale;
}
