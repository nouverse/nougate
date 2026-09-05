/**
 * One request to Anthropic, with however many credentials it takes.
 *
 * The same rotate-on-failure shape as the Copilot executor, and it differs in exactly two places,
 * both because the credential here belongs to a person rather than to a token exchange:
 *
 *   - A **401 tries a refresh first**. On Copilot a 401 means the session token is spent and a new
 *     one is one exchange away. Here it usually means an OAuth access token aged out, and the fix is
 *     the operator's CLI — so the credential is refreshed and retried *once* before being written off.
 *     Marking it invalid on the first 401 would retire a perfectly good subscription every few hours.
 *   - **Rate-limit headers are recorded on every response**, success or not. Anthropic sends them
 *     unconditionally, so the Quota tab costs nothing; asking for headroom separately would spend a
 *     request to learn what the last one already said.
 */

import type { IModelSpec } from '@/core/interfaces';
import { classifyUpstreamError, ModelUnavailableError } from '@/core/upstream-errors';
import { getProxyConfig } from '@/config/manager';
import { buildRequestHeaders } from './headers';
import {
  cooldownScope,
  getBestAccount,
  invalidate,
  markCooldown,
  needsRefresh,
  recordRateLimit,
  replaceCredential,
  storeRefreshedTokens,
  updateAccountUsage,
} from '../auth/manager';
import { CLAUDE_OAUTH, refreshTokens } from '../auth/oauth';
import { isPermanentRefreshFailure, type TokenRefreshError } from '../auth/refresh-errors';
import type { ClaudeCodeAccount } from '../auth/types';
import { getClaudeCodeConfig } from '../config/provider-config';
import { refreshAccessToken } from './refresh';

/**
 * Renew a token that is about to expire, before it is spent on a request.
 *
 * Proactive because the reactive path costs a whole round trip: without this, every token simply
 * runs out mid-conversation and the 401 handler below picks up the pieces. With it, the expiry is a
 * background HTTP call nobody notices.
 *
 * Failure here is deliberately quiet — it returns and lets the request go out on the old token. The
 * token may still have hours left (the lead is four of them), and refusing to try would turn a
 * transient network blip into a failed turn.
 */
async function refreshIfExpiring(account: ClaudeCodeAccount): Promise<void> {
  if (!needsRefresh(account, CLAUDE_OAUTH.refreshLeadMs)) return;
  try {
    const tokens = await refreshTokens(account.refreshToken!);
    await storeRefreshedTokens(account.id, tokens);
  } catch (error) {
    /**
     * Still quiet, but not equally quiet.
     *
     * A stated rejection here means the grant is gone and the operator has to sign in again — that is
     * worth an error line, because the access token this request is about to use has hours left and
     * the account will look healthy right up until it stops. The account is *not* invalidated: the
     * credential in hand still works, and retiring it now would throw away those hours.
     */
    if (isPermanentRefreshFailure(error)) {
      console.error(
        `[claude-code] ${account.label} can no longer renew itself — sign in again (${(error as TokenRefreshError).failure.code || 'no reason given'})`,
      );
      return;
    }
    console.warn(
      `[claude-code] could not renew ${account.label} ahead of expiry: ${String(error).slice(0, 200)}`,
    );
  }
}

export interface ClaudeCodeExecuteOptions {
  body: unknown;
  modelSpec: IModelSpec;
  clientId?: string;
}

export interface ClaudeCodeExecuteResult {
  response: Response;
  accountId: string;
  attempts: number;
}

/** A 429 with no `retry-after` still has to wait for something. A minute, as Copilot uses. */
const DEFAULT_COOLDOWN_MS = 60_000;

/**
 * How long a credential sits out after a refresh failed for a reason the server did not state.
 *
 * Short on purpose. It is not a punishment — it is long enough that a burst of requests does not
 * re-attempt a refresh that is failing, and short enough that a passing network problem costs one
 * cooling window rather than an operator's attention.
 */
const REFRESH_RETRY_COOLDOWN_MS = 30_000;

export class ClaudeCodeExecutor {
  async execute(options: ClaudeCodeExecuteOptions): Promise<ClaudeCodeExecuteResult> {
    const proxyConfig = getProxyConfig();
    const maxAttempts = Math.max(proxyConfig?.retry?.maxAttempts || 3, 3);
    const { modelSpec } = options;
    const modelId = modelSpec.modelId;
    const upstreamModelId = modelSpec.upstreamModelId || modelId;
    const scope = cooldownScope(modelId);
    const url = `${getClaudeCodeConfig().baseUrl.replace(/\/$/, '')}/v1/messages`;

    const tried: string[] = [];
    let attempts = 0;
    /** Reset per account: a refresh is offered once per credential, not once per request. */
    let refreshedThisAccount = false;

    while (attempts < maxAttempts) {
      attempts++;

      const account = await getBestAccount(modelId, tried);
      if (!account) {
        throw new Error(
          tried.length > 0
            ? `Every Claude Code credential failed or is cooling down (${tried.length} tried).`
            : 'No Claude Code credentials are available. Add one on the provider page.',
        );
      }
      if (!tried.includes(account.id)) {
        tried.push(account.id);
        refreshedThisAccount = false;
      }

      await refreshIfExpiring(account);

      const body = { ...(options.body as Record<string, unknown>), model: upstreamModelId };
      const timeoutMs = modelSpec.timeoutMs ?? 600_000;
      const controller = new AbortController();
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      try {
        // Jitter is applied once per request by `executeProviderRequest`, before this is reached.
        timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        const response = await fetch(url, {
          method: 'POST',
          headers: buildRequestHeaders(account.credential),
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        // Free information, on every response including the failures.
        await recordRateLimit(account.id, response.headers);

        if (response.status === 401) {
          if (account.kind === 'oauth' && !refreshedThisAccount) {
            refreshedThisAccount = true;

            /**
             * Two ways to heal a 401, in order of how much they know.
             *
             * An account from the OAuth flow holds a refresh token and can renew itself — no CLI on
             * the host, no operator. A pasted `setup-token` cannot, and falls through to the
             * configured refresh command, which is the only thing that can mint it a new one.
             */
            if (account.refreshToken) {
              try {
                const tokens = await refreshTokens(account.refreshToken);
                await storeRefreshedTokens(account.id, tokens);
                tried.splice(tried.indexOf(account.id), 1);
                console.warn(`[claude-code] renewed ${account.label} after a 401`);
                continue;
              } catch (error) {
                /**
                 * Only a reason the server actually stated retires the account.
                 *
                 * `invalidate` is permanent and nothing but an operator brings an account back, so
                 * spending it on a refresh that failed for an unstated reason — a 500, a DNS blip, a
                 * proxy returning HTML — retires a working subscription over a dropped packet. The
                 * transient case cools the credential briefly instead: other credentials answer in
                 * the meantime, and this one is offered again once the window passes.
                 */
                if (isPermanentRefreshFailure(error)) {
                  await invalidate(
                    account.id,
                    `refresh token rejected — sign in again (${(error as TokenRefreshError).failure.code || 'no reason given'})`,
                  );
                } else {
                  await markCooldown(account.id, scope, REFRESH_RETRY_COOLDOWN_MS);
                  console.warn(
                    `[claude-code] could not renew ${account.label}, cooling ${REFRESH_RETRY_COOLDOWN_MS}ms: ${String(error).slice(0, 200)}`,
                  );
                }
                await updateAccountUsage(account.id, false, { statusCode: 401 });
                continue;
              }
            }

            const { token, error } = await refreshAccessToken();
            if (token) {
              await replaceCredential(account.id, token);
              // Same account, same attempt budget — the retry below picks it up because a successful
              // replace clears the state that would have skipped it.
              tried.splice(tried.indexOf(account.id), 1);
              console.warn(`[claude-code] refreshed the token on ${account.label} after a 401`);
              continue;
            }
            await invalidate(account.id, `token expired and could not be refreshed — ${error}`);
          } else {
            await invalidate(
              account.id,
              account.kind === 'oauth'
                ? 'token expired and the refresh did not produce a working one'
                : 'the API key was rejected',
            );
          }
          await updateAccountUsage(account.id, false, { statusCode: 401 });
          continue;
        }

        if (response.status === 429) {
          const retryAfter = Number(response.headers.get('retry-after'));
          const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : DEFAULT_COOLDOWN_MS;
          await markCooldown(account.id, scope, waitMs);
          await updateAccountUsage(account.id, false, { statusCode: 429 });
          console.warn(`[claude-code] ${account.label} rate limited on ${modelId}; cooling ${waitMs}ms`);
          continue;
        }

        if (!response.ok) {
          const text = await response.text();
          const classification = classifyUpstreamError({ status: response.status, body: text });

          // Every credential queries the same catalogue, so a model Anthropic does not offer is not
          // this account's fault and no other will answer differently. Rotating would drop the health
          // score of every healthy credential over a caller's typo, then report it as "failed after
          // N attempts" — hiding the real cause.
          if (classification.kind === 'model_unsupported') {
            throw new ModelUnavailableError(
              `Anthropic does not offer "${modelId}". Check the model list on the provider page.`,
            );
          }

          console.error(
            `[claude-code] ${response.status} from upstream (${classification.kind}): ${text.slice(0, 300)}`,
          );
          await updateAccountUsage(account.id, false, { statusCode: response.status });
          continue;
        }

        await updateAccountUsage(account.id, true, { statusCode: 200 });
        return { response, accountId: account.id, attempts };
      } catch (error) {
        clearTimeout(timeoutId);
        if (error instanceof ModelUnavailableError) throw error;
        const aborted = (error as { name?: string })?.name === 'AbortError';
        console.error(
          aborted
            ? `[claude-code] ${account.label} timed out after ${timeoutMs}ms`
            : `[claude-code] request failed on ${account.label}: ${String(error).slice(0, 200)}`,
        );
        await updateAccountUsage(account.id, false, { statusCode: 500 });
      }
    }

    throw new Error(`Upstream request failed after ${attempts} attempts.`);
  }
}
