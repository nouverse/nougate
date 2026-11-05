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

import type { AccountRequestOptions, IAccount, IModelRegistry, IProvider, IProviderQuota, ProviderExecuteParams, AccountCopy } from '@/core/interfaces';
import { normalizeJitterConfig, type JitterConfig } from '@/core/jitter';
import {
  addAccount,
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
import { beginAuthorization, exchangeCode } from './auth/oauth';
import { getUsage } from './api/usage';
import type { ClaudeCodeAccount } from './auth/types';
import { claudeCodeModelRegistry } from './config/model-specs';
import {
  getClaudeCodeConfig,
  loadClaudeCodeConfig,
  updateClaudeCodeConfig,
  type ClaudeCodeConfig,
} from './config/provider-config';
import { ClaudeCodeExecutor } from './upstream/executor';
import { sanitizeAnthropicBody } from './mappers/anthropic';
import { dropUnusableThinking } from './mappers/thinking';
import { dropDeprecatedSampling } from './mappers/sampling';
import { adaptToolNames, restoreResponse, type ToolNameMap } from './mappers/tool-names';
import { applyEnvelope } from './upstream/body-envelope';
import { credentialKind } from './auth/credential';
import {
  createAnthropicToOpenAIStreamTransformer,
  finalizeAnthropicToOpenAIResponse,
  mapOpenAIToAnthropic,
} from './mappers/openai';

/** The default manual cooldown, matching the dashboard's "Trigger Cooldown (1h)" label. */
const HOUR_MS = 3_600_000;

const STREAM_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  'Access-Control-Allow-Origin': '*',
};

/**
 * The redirect URI for Claude's OAuth.
 *
 * **Always loopback, never `BASE_URL`.** Claude Code's client id is a native/CLI client: it accepts
 * `http://localhost:{port}/callback` — any port, RFC 8252 — and rejects anything else. Building this
 * from `BASE_URL` worked on a laptop by coincidence, because there `BASE_URL` *is* loopback, and
 * broke the moment the gateway was deployed to a real domain: the authorize request went out with
 * `https://<host>/callback` and was refused before the operator ever saw a consent screen.
 *
 * Codex has the same constraint and states it as a constant; this one now does too.
 *
 * ## What that means for a deployed gateway
 *
 * The browser lands on `localhost` afterwards, which is the operator's own machine and not the
 * server — so the tab fails to load. That is the expected shape of this flow, not a failure: the
 * code is in that URL, and the dialog takes it pasted. On a local run the address happens to be the
 * gateway itself, so the exchange finishes on its own and the dialog closes. Same URI, two outcomes,
 * and neither needs configuring.
 *
 * `addAccount({ redirectUri })` still overrides it, for an operator who knows their client id
 * accepts something else.
 */
function getClaudeCallbackUri(): string {
  const port = process.env.PORT?.trim() || '3000';
  return `http://localhost:${port}/callback`;
}

export class ClaudeCodeProvider implements IProvider {
  readonly id = 'claudecode';
  readonly displayName = 'Claude Code';

  readonly accountFlow = 'oauth-redirect' as const;

  readonly accountCopy: AccountCopy = {
    label: 'Claude',
    hint: 'Claude Pro or Max subscription',
    order: 1,
    title: 'Add Claude Account',
    intro: 'Signs in with your Claude subscription. Open the link in a new tab, approve, and bring the result back here.',
    button: 'Sign In with Claude',
    consent:
      'Approve in the new tab. Anthropic redirects to a localhost address, so on a local gateway it lands back here and the account is added for you. On a deployed one that address is your own machine, not the server, and the tab will fail to load — that is expected. Copy its full URL and paste it below.',
    pasteLabel: 'Paste Redirect URL',
    pastePlaceholder: 'Paste the entire redirected URL, or just the code, here...',
  };

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

  /**
   * `meta` is in the shared `IProvider` shape and carries nothing this provider acts on: health here
   * moves on success or failure alone, and the status code is already logged by the executor that
   * saw it. Accepted and dropped rather than threaded through to a parameter nobody reads.
   */
  async updateAccountUsage(accountId: string, success: boolean): Promise<void> {
    await updateAccountUsage(accountId, success);
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
    const responseModelId = `claudecode:${modelSpec.modelId}`;
    const executor = new ClaudeCodeExecutor();

    if (protocol === 'anthropic') {
      // `dropUnusableThinking` first: a replayed thinking block with a signature the upstream will
      // not accept rejects the whole request, and the error names a block index rather than a cause.
      const { body: adaptedBody, toolNameMap } = this.adaptTools(
        dropDeprecatedSampling(
          dropUnusableThinking(sanitizeAnthropicBody(body, upstreamModelId)),
          upstreamModelId,
        ),
      );
      // Body-level transformations (billing header + user_id metadata) run after tool name mapping so the billing
      // hash covers the final payload shape. Gated on OAuth credential via the executor's account.
      const upstreamBody = this.applyBodyEnvelope(adaptedBody, ctx);

      const result = await executor.execute({
        body: upstreamBody,
        modelSpec,
        clientId: ctx.clientId,
        conversation: ctx.sessionId,
      });

      return await restoreResponse(result.response, toolNameMap, isStreaming);
    }

    if (protocol === 'openai') {
      const { body: adaptedBody, toolNameMap } = this.adaptTools(
        dropDeprecatedSampling(
          mapOpenAIToAnthropic(body, upstreamModelId, modelSpec.maxOutputTokens, this.id),
          upstreamModelId,
        ),
      );
      const upstreamBody = this.applyBodyEnvelope(adaptedBody, ctx);

      const result = await executor.execute({
        body: upstreamBody,
        modelSpec,
        clientId: ctx.clientId,
        conversation: ctx.sessionId,
      });

      // Name restoration runs *before* the protocol translation, not after: it is an Anthropic-shaped
      // rewrite, and doing it here means the OpenAI mappers never need to know this mechanic exists.
      const restored = await restoreResponse(result.response, toolNameMap, isStreaming);

      if (isStreaming) {
        if (!restored.body) throw new Error('No response body from upstream Anthropic');
        return new Response(
          restored.body.pipeThrough(createAnthropicToOpenAIStreamTransformer(responseModelId)),
          { status: 200, headers: { ...STREAM_HEADERS, 'X-Claude-Code-Attempts': String(result.attempts) } },
        );
      }

      return await finalizeAnthropicToOpenAIResponse(restored, responseModelId);
    }

    throw new Error(`Unsupported protocol: ${protocol}`);
  }

  /**
   * Apply body-level transformations: billing header as system[0] + metadata.user_id.
   *
   * Always runs (the function itself gates on OAuth), so both protocol paths get it without drift.
   * The credential for the "is this OAuth?" check comes from the best account in the pool — the same
   * one the executor will pick. When no accounts exist, transformation is skipped.
   */
  private applyBodyEnvelope(body: unknown, ctx: { clientId?: string; sessionId?: string }): unknown {
    const accounts = getAccounts();
    if (accounts.length === 0) return body;
    // Use the first healthy account's credential to determine kind. The executor will pick the best
    // one, but the OAuth check only needs to know whether the pool is OAuth-backed.
    const bestAccount = accounts.find((a) => !a.invalidatedAt);
    if (!bestAccount) return body;
    const isOAuth = credentialKind(bestAccount.credential) === 'oauth';
    return applyEnvelope(body, isOAuth, ctx.sessionId, bestAccount.credential);
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
            `[claudecode] usage lookup failed for ${account.label}: ${String(error).slice(0, 200)}`,
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
   *   - `{}`               — begin. Returns the URL to open; the redirect lands on the gateway's own
   *                           `/callback` endpoint.
   *   - `{ code, state }`  — finish (called by the callback route). Exchanges and stores the tokens.
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
        console.error('[claudecode] addAccount({ code }) called but no pending authorization exists');
        throw Object.assign(new Error('Start the sign-in again — no authorization is in progress.'), {
          status: 409,
        });
      }
      console.log(`[claudecode] exchanging code (${body.code.slice(0, 8)}…) with redirect_uri=${pending.redirectUri}`);
      try {
        const tokens = await exchangeCode(body.code, pending.redirectUri, pending.codeVerifier, pending.state);
        this.pending = null;

        const account = await addOAuthAccount({
          accessToken: tokens.access_token,
          ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
          ...(tokens.expires_in ? { expiresInSeconds: tokens.expires_in } : {}),
          ...(body.label ? { label: body.label } : {}),
        });
        console.log(`[claudecode] account added: ${account.label}`);
        return { success: true, email: account.label };
      } catch (err: any) {
        console.error(`[claudecode] token exchange failed:`, err?.message || err);
        throw err;
      }
    }

    const redirectUri = body?.redirectUri || getClaudeCallbackUri();
    const started = beginAuthorization(redirectUri);
    // Held in memory only: a half-finished sign-in that does not survive a restart is correct — the
    // operator simply starts again, and a verifier on disk is a secret with no owner.
    this.pending = { ...started, redirectUri };
    // `redirectUrl`, not `authUrl`: the dashboard's OAuth tab already speaks this shape for
    // Antigravity, and matching it is what lets one component serve both providers.
    return { redirectUrl: started.url, state: started.state };
  }

  /**
   * Suffix client tool names, when the operator has left that on.
   *
   * A thin wrapper so the two protocol paths cannot drift on the config read — an `if` in one branch
   * and not the other is exactly the kind of asymmetry that shows up as "tools work on the OpenAI
   * endpoint but not the Anthropic one".
   */
  private adaptTools(body: unknown): { body: unknown; toolNameMap: ToolNameMap | null } {
    const config = getClaudeCodeConfig();
    if (!config.adaptToolNames) return { body, toolNameMap: null };
    return adaptToolNames(body, config.toolNameSuffix);
  }

  /**
   * The provider settings, for the dashboard's Provider Config tab.
   *
   * Without these two the tab is not hidden — it renders an empty editor and reports a save that
   * went nowhere, because `admin.ts` falls back to `{}` for a provider that implements neither.
   */
  getConfig(): ClaudeCodeConfig {
    return getClaudeCodeConfig();
  }

  async updateConfig(updates: Partial<ClaudeCodeConfig>): Promise<ClaudeCodeConfig> {
    return updateClaudeCodeConfig(updates);
  }

  async removeAccount(accountId: string): Promise<void> {
    const removed = await removeAccount(accountId);
    if (!removed) throw new Error(`no account matches "${accountId}"`);
  }

  /**
   * Forget what the gateway concluded about a credential.
   *
   * Throws when nothing matched rather than returning quietly: the dashboard reports whatever comes
   * back as success, so a silent miss here is an operator watching a benched account stay benched
   * after pressing a button that told them it worked.
   */
  async resetAccount(accountId: string): Promise<void> {
    const reset = await resetAccount(accountId);
    if (!reset) throw new Error(`no account matches "${accountId}"`);
  }

  /**
   * Bench a credential by hand.
   *
   * Account-wide rather than per model — an operator reaching for Cooldown is taking the credential
   * out of rotation entirely, not steering one model away from it. `pool` is in the signature every
   * provider shares and ignored here: Antigravity splits its quota between a cli and a sandbox pool,
   * Anthropic has nothing of the kind.
   */
  async markAccountCooldown(accountId: string, _pool: string, duration?: string): Promise<void> {
    const marked = await markCooldown(accountId, cooldownScope(), parseDurationMs(duration) ?? HOUR_MS);
    if (!marked) throw new Error(`no account matches "${accountId}"`);
  }

  /**
   * The dashboard's per-account buttons.
   *
   * Only the two this provider can honour. `rediscover_project` is deliberately absent: a
   * cloudaicompanion project is a Google concept, and answering it here would mean inventing state
   * Anthropic does not have.
   */
  async handleAccountAction(accountId: string, action: string, payload?: any): Promise<any> {
    switch (action) {
      case 'reset':
        await this.resetAccount(accountId);
        return { ok: true };
      case 'cooldown':
        await this.markAccountCooldown(accountId, payload?.pool ?? 'account', payload?.duration);
        return { ok: true };
      default:
        throw new Error(`Action "${action}" is not supported by the Claude Code provider`);
    }
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

/**
 * Read the dashboard's `"3600s"` style duration.
 *
 * Returns undefined rather than a fallback when the string is missing or malformed, so the caller
 * decides the default in one place instead of two disagreeing ones.
 */
function parseDurationMs(duration?: string): number | undefined {
  if (!duration) return undefined;
  const match = /^(\d+)(ms|s|m|h)?$/.exec(duration.trim());
  if (!match) return undefined;
  const value = Number(match[1]);
  const unit = match[2] ?? 's';
  const scale = unit === 'ms' ? 1 : unit === 's' ? 1_000 : unit === 'm' ? 60_000 : HOUR_MS;
  return value * scale;
}

function formatResetIn(at: number): string {
  const ms = at - Date.now();
  if (ms <= 0) return 'now';
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}
