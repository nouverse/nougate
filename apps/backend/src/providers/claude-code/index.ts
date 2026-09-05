/**
 * Anthropic, reached with a credential the operator already has.
 *
 * The third kind of provider in this gateway. Antigravity and Copilot both wrap an upstream that
 * speaks somebody else's dialect and needs an OAuth client of its own; this one talks to the
 * Messages API directly, with a credential handed over whole. That removes the two largest parts of
 * a provider — the auth flow and the translation — and what is left is selection, rotation, and
 * knowing which header a credential belongs on.
 *
 * `accountFlow` is `oauth-redirect`, the same flow Antigravity uses: the point of this provider is a
 * **subscription** credential, not an API key. A custom provider already reaches `api.anthropic.com`
 * with a key, so if that were all this offered it would be redundant.
 *
 * A pasted `claude setup-token` and an API key are both still accepted through the same
 * `addAccount` entry point, because the header logic has to tell the kinds apart anyway. They are
 * simply not what the button is for. Which kind a credential is comes from the credential itself;
 * see `auth/credential.ts`.
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
  addAccount,
  addOAuthAccount,
  getAccounts,
  getBestAccount,
  initManager,
  removeAccount,
  updateAccountUsage,
} from './auth/manager';
import { beginAuthorization, exchangeCode } from './auth/oauth';
import { getUsage } from './api/usage';
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

/**
 * Where Claude sends the operator back after they approve.
 *
 * Claude's own console URL, matching the reference implementation — the authorize page shows the
 * code on screen rather than only redirecting, which is what makes a paste-back flow work at all on
 * a gateway that may not be reachable from the browser doing the sign-in.
 */
const DEFAULT_REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback';

export class ClaudeCodeProvider implements IProvider {
  readonly id = 'claude-code';
  readonly displayName = 'Claude Code';

  readonly accountFlow = 'oauth-redirect' as const;

  /** The in-flight authorization, if the operator has started one. See `addAccount`. */
  private pending: { url: string; state: string; codeVerifier: string; redirectUri: string } | null =
    null;

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
   * Headroom, asked for where it can be asked for and inferred where it cannot.
   *
   * Two sources, in that order of preference:
   *
   *   1. **`/api/oauth/usage`** — the plan's own five-hour and weekly windows, per model. This is the
   *      number the operator is actually looking for, and the only one that can say "83% of the
   *      session window is gone" before a request starts failing.
   *   2. **The rate-limit headers on the last response** — free, but on a consumer subscription they
   *      usually carry a status and no figures, which reads as "unlimited" for a plan that has a
   *      very real cap.
   *
   * Reported per credential rather than merged: two credentials on different plans have genuinely
   * different ceilings, and an average would describe neither. A credential with neither source is
   * left out entirely — a full bar for something never measured is a claim, not a reading.
   *
   * Never throws. A quota panel is supplementary, and a `getQuotas` that rejects takes down a
   * dashboard over an endpoint that has no bearing on serving traffic.
   */
  async getQuotas(): Promise<IProviderQuota[]> {
    const accounts = getAccounts().filter((account) => !account.invalidatedAt);

    const reported = await Promise.all(
      accounts.map(async (account) => {
        try {
          const usage = await getUsage(account.credential);
          if (!usage || usage.windows.length === 0) return [];

          return usage.windows.map<IProviderQuota>((window) => ({
            // Scoped by account: two credentials both report a "session (5h)" window, and a shared id
            // would collapse them into one row in the dashboard's list.
            id: `${account.id}:${window.label}`,
            label: `${account.label} — ${window.label}`,
            remainingFraction: window.remainingFraction,
            used: `${Math.round(window.utilizationPercent)}%`,
            limit: '100%',
            unit: 'of window used',
            ...(window.resetsAt ? { resetIn: formatResetIn(window.resetsAt) } : {}),
          }));
        } catch (error) {
          console.warn(
            `[claude-code] usage lookup failed for ${account.label}: ${String(error).slice(0, 200)}`,
          );
          return [];
        }
      }),
    );

    const quotas = reported.flat();
    const covered = new Set(quotas.map((quota) => quota.id.split(':')[0]));

    // Header-derived rows only for the credentials the usage endpoint could not describe. Emitting
    // both would show one account twice with two different numbers and no way to tell which is real.
    return [
      ...quotas,
      ...this.headerQuotas(accounts.filter((account) => !covered.has(account.id))),
    ];
  }

  /** The fallback reading, from what the last response's headers happened to carry. */
  private headerQuotas(accounts: ClaudeCodeAccount[]): IProviderQuota[] {
    return accounts
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
   * Both halves of adding an account, behind one entry point.
   *
   * The router exposes `addAccount(body)` generically and nothing else, which is the right shape: a
   * provider that needed its own routes would be a provider the dashboard has to know the id of, and
   * this codebase has already been burned by keying UI off provider ids.
   *
   * So the body decides which step this is:
   *
   *   - `{}`               — begin. Returns the URL to open and remembers the PKCE verifier.
   *   - `{ code }`         — finish. Exchanges it and stores the tokens.
   *   - `{ apiKey }`       — skip the flow entirely: a pasted key or `claude setup-token` token.
   */
  async addAccount(body: {
    code?: string;
    state?: string;
    apiKey?: string;
    label?: string;
    redirectUri?: string;
  }): Promise<unknown> {
    if (body?.apiKey) {
      const account = await addAccount(body.apiKey, body.label);
      return { success: true, email: account.label };
    }

    if (body?.code) {
      const pending = this.pending;
      if (!pending) {
        throw Object.assign(new Error('Start the sign-in again — no authorization is in progress.'), {
          status: 409,
        });
      }
      const tokens = await exchangeCode(body.code, pending.redirectUri, pending.codeVerifier, pending.state);
      this.pending = null;

      const account = await addOAuthAccount({
        accessToken: tokens.access_token,
        ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
        ...(tokens.expires_in ? { expiresInSeconds: tokens.expires_in } : {}),
        ...(body.label ? { label: body.label } : {}),
      });
      return { success: true, email: account.label };
    }

    const redirectUri = body?.redirectUri || DEFAULT_REDIRECT_URI;
    const started = beginAuthorization(redirectUri);
    // Held in memory only: a half-finished sign-in that does not survive a restart is correct — the
    // operator simply starts again, and a verifier on disk is a secret with no owner.
    this.pending = { ...started, redirectUri };
    // `redirectUrl`, not `authUrl`: the dashboard's OAuth tab already speaks this shape for
    // Antigravity, and matching it is what lets one component serve both providers.
    return { redirectUrl: started.url, state: started.state };
  }

  async removeAccount(accountId: string): Promise<void> {
    await removeAccount(accountId);
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
