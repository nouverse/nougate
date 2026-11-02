/**
 * Codex upstream executor — one request, with however many credentials it takes.
 *
 * Handles: account rotation, credential refresh (proactive + reactive), SSE peek/retry for
 * transient errors hidden inside 200 OK bodies, and error classification.
 */

import { randomUUID } from 'node:crypto';
import type { IModelSpec } from '@/core/interfaces';
import { ProviderResponseError, upstreamMessage } from '@/core/upstream-errors';
import { reframeResponse } from '@/core/response-framing';
import {
  cooldownScope,
  getBestAccount,
  invalidate,
  markCooldown,
  needsRefresh,
  storeRefreshedTokens,
  updateAccountUsage,
} from '../auth/manager';
import { refreshTokens, isPermanentRefreshFailure, type TokenRefreshError } from '../auth/oauth';
import type { CodexAccount } from '../auth/types';
import { getCodexConfig } from '../config/provider-config';
import { transformCodexRequest } from './request-transform';
import { peekSseTransientError, MODEL_CAPACITY_MESSAGE, streamFailureAnswer } from './stream';

const CODEX_ORIGINATOR = 'codex_cli_rs';

/** Default cooldown for 429s without retry-after. */
const DEFAULT_COOLDOWN_MS = 60_000;

/** How long a credential sits out after a non-permanent refresh failure. */
const REFRESH_RETRY_COOLDOWN_MS = 30_000;

/** Max SSE retry attempts for transient overloaded errors. */
const MAX_SSE_RETRIES = 2;
const SSE_RETRY_DELAY_MS = 3_000;

function codexSseErrorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({
    error: {
      message,
      type: status >= 500 ? 'server_error' : 'invalid_request_error',
      code: status === 503 ? 'service_unavailable' : 'upstream_error',
    },
  }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Build Codex-specific request headers.
 */
function buildHeaders(account: CodexAccount): Record<string, string> {
  // One read, used twice: the two must agree, and a User-Agent claiming one version beside a
  // `version` header claiming another is a fingerprint no real CLI produces.
  const cliVersion = getCodexConfig().cliVersion;

  const headers: Record<string, string> = {
    'accept': 'text/event-stream, application/json',
    'authorization': `Bearer ${account.accessToken}`,
    'content-type': 'application/json',
    'originator': CODEX_ORIGINATOR,
    'session_id': randomUUID(),
    'user-agent': `${CODEX_ORIGINATOR}/${cliVersion}`,
    'version': cliVersion,
    'x-client-request-id': randomUUID(),
  };

  // Account/workspace binding header — required for multi-account setups
  const accountId = account.chatgptAccountId;
  if (accountId) {
    headers['ChatGPT-Account-ID'] = accountId;
  }

  return headers;
}

/**
 * Proactive refresh: renew before the token expires, quietly.
 */
async function refreshIfNeeded(account: CodexAccount): Promise<void> {
  if (!needsRefresh(account)) return;
  try {
    const tokens = await refreshTokens(account.refreshToken);
    await storeRefreshedTokens(account.id, tokens);
  } catch (error) {
    if (isPermanentRefreshFailure(error)) {
      console.error(
        `[codex] ${account.label} can no longer renew itself — sign in again (${(error as TokenRefreshError).failure.code || 'no reason given'})`,
      );
      return;
    }
    console.warn(
      `[codex] could not renew ${account.label} ahead of expiry: ${String(error).slice(0, 200)}`,
    );
  }
}

export interface CodexExecuteOptions {
  body: Record<string, any>;
  modelSpec: IModelSpec;
  clientId?: string;
}

export interface CodexExecuteResult {
  response: Response;
  accountId: string;
  attempts: number;
}

export class CodexExecutor {
  async execute(options: CodexExecuteOptions): Promise<CodexExecuteResult> {
    const maxAttempts = 3;
    const { modelSpec } = options;
    const modelId = modelSpec.modelId;
    const scope = cooldownScope(modelId);

    // The resolved spec decides the model, not the client's string: what arrives is still prefixed
    // (`codex:gpt-5.5`), and sending that upstream is a refusal — "the 'codex:gpt-5.5' model is not
    // supported when using Codex with a ChatGPT account" — that reads like a plan problem rather
    // than a routing one.
    const { body: transformedBody, isCompact } = transformCodexRequest(
      modelId,
      { ...options.body, model: modelSpec.upstreamModelId || modelId },
    );

    const baseUrl = getCodexConfig().baseUrl.replace(/\/$/, '');
    const url = isCompact ? `${baseUrl}/compact` : baseUrl;
    const timeoutMs = modelSpec.timeoutMs ?? 600_000;

    const tried: string[] = [];
    let attempts = 0;
    let refreshedThisAccount = false;

    accounts: while (attempts < maxAttempts) {
      attempts++;

      const account = await getBestAccount(modelId, tried);
      if (!account) {
        throw new Error(
          tried.length > 0
            ? `Every Codex credential failed or is cooling down (${tried.length} tried).`
            : 'No Codex credentials are available. Add one on the provider page.',
        );
      }
      if (!tried.includes(account.id)) {
        tried.push(account.id);
        refreshedThisAccount = false;
      }

      await refreshIfNeeded(account);

      const controller = new AbortController();
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      try {
        timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        const response = await fetch(url, {
          method: 'POST',
          headers: buildHeaders(account),
          body: JSON.stringify(transformedBody),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (response.status === 401) {
          if (!refreshedThisAccount) {
            refreshedThisAccount = true;
            try {
              const tokens = await refreshTokens(account.refreshToken);
              await storeRefreshedTokens(account.id, tokens);
              tried.splice(tried.indexOf(account.id), 1);
              console.warn(`[codex] renewed ${account.label} after a 401`);
              continue;
            } catch (error) {
              if (isPermanentRefreshFailure(error)) {
                await invalidate(
                  account.id,
                  `refresh token rejected — sign in again (${(error as TokenRefreshError).failure.code || 'no reason given'})`,
                );
              } else {
                await markCooldown(account.id, scope, REFRESH_RETRY_COOLDOWN_MS);
                console.warn(
                  `[codex] could not renew ${account.label}, cooling ${REFRESH_RETRY_COOLDOWN_MS}ms: ${String(error).slice(0, 200)}`,
                );
              }
              await updateAccountUsage(account.id, false);
              continue;
            }
          }
          await invalidate(account.id, 'token expired and the refresh did not produce a working one');
          await updateAccountUsage(account.id, false);
          continue;
        }

        if (response.status === 429) {
          // Parse usage_limit_reached for precise reset time
          let waitMs = DEFAULT_COOLDOWN_MS;
          const retryAfter = Number(response.headers.get('retry-after'));
          if (Number.isFinite(retryAfter) && retryAfter > 0) {
            waitMs = retryAfter * 1000;
          } else {
            try {
              const text = await response.clone().text();
              const json = JSON.parse(text);
              const err = json?.error;
              if (err?.type === 'usage_limit_reached') {
                if (typeof err.resets_at === 'number' && err.resets_at > 0) {
                  const ms = err.resets_at * 1000;
                  if (ms > Date.now()) waitMs = ms - Date.now();
                } else if (typeof err.resets_in_seconds === 'number' && err.resets_in_seconds > 0) {
                  waitMs = err.resets_in_seconds * 1000;
                }
              }
            } catch { /* ignore parse errors */ }
          }
          await markCooldown(account.id, scope, waitMs);
          await updateAccountUsage(account.id, false);
          console.warn(`[codex] ${account.label} rate limited on ${modelId}; cooling ${waitMs}ms`);
          continue;
        }

        if (!response.ok) {
          const text = await response.text();
          console.error(`[codex] ${response.status} from upstream: ${text.slice(0, 300)}`);

          // A 4xx that is not 401 or 429 is the request's fault, and every credential on the same
          // plan refuses the same body identically. This used to charge the account before giving
          // up on it: asking for six models a plan does not include took a healthy credential from
          // 100 to 0 in six requests, and left a red badge describing a caller's typo.
          if (response.status >= 400 && response.status < 500) {
            throw new ProviderResponseError(upstreamMessage(text, 'the upstream refused the request'), {
              status: response.status,
              clientCode: 'upstream_error',
            });
          }

          await updateAccountUsage(account.id, false);
          continue;
        }

        // SSE peek/retry loop for transient errors hidden inside 200 OK bodies
        let sseAttempt = 0;
        let currentResponse = response;
        while (true) {
          const peek = await peekSseTransientError(currentResponse);
          if (peek.failure) {
            const answer = streamFailureAnswer(peek.failure.code);
            console.warn(`[codex] ${account.label} failed on ${modelId} before answering: ${peek.failure.code ?? 'no code'} — ${peek.failure.message.slice(0, 200)}`);
            // A usage limit is this credential's, as a 429 is above: it sits out, and the next one is asked.
            if (answer.status === 429) {
              await markCooldown(account.id, scope, DEFAULT_COOLDOWN_MS);
              await updateAccountUsage(account.id, false);
              continue accounts;
            }
            // A window exceeded or a prompt refused is the request's, and every credential would say the same.
            if (answer.status >= 500) await updateAccountUsage(account.id, false);
            throw new ProviderResponseError(peek.failure.message, { status: answer.status, clientCode: answer.clientCode });
          }
          if (!peek.matched) {
            // Replace body with re-assembled stream (prefix bytes already read + rest)
            if (peek.replacementBody) {
              currentResponse = new Response(peek.replacementBody, {
                status: currentResponse.status,
                statusText: currentResponse.statusText,
                headers: currentResponse.headers,
              });
            }
            await updateAccountUsage(account.id, true);
            return { response: reframeResponse(currentResponse), accountId: account.id, attempts };
          }

          if (peek.accountFallback) {
            console.warn(`[codex] SSE account fallback "${peek.message}"`);
            await updateAccountUsage(account.id, false);
            return {
              response: codexSseErrorResponse(503, peek.message || MODEL_CAPACITY_MESSAGE),
              accountId: account.id,
              attempts,
            };
          }

          if (sseAttempt >= MAX_SSE_RETRIES) {
            console.warn(`[codex] SSE overloaded "${peek.matched}" — retries exhausted (${sseAttempt}/${MAX_SSE_RETRIES})`);
            return {
              response: codexSseErrorResponse(503, peek.message || peek.matched),
              accountId: account.id,
              attempts,
            };
          }

          sseAttempt++;
          console.warn(`[codex] SSE "${peek.matched}" retry ${sseAttempt}/${MAX_SSE_RETRIES} after ${SSE_RETRY_DELAY_MS / 1000}s`);
          await new Promise((r) => setTimeout(r, SSE_RETRY_DELAY_MS));

          // Re-send the request
          const retryController = new AbortController();
          const retryTimeoutId = setTimeout(() => retryController.abort(), timeoutMs);
          try {
            currentResponse = await fetch(url, {
              method: 'POST',
              headers: buildHeaders(account),
              body: JSON.stringify(transformedBody),
              signal: retryController.signal,
            });
          } finally {
            clearTimeout(retryTimeoutId);
          }

          if (!currentResponse.ok) {
            await updateAccountUsage(account.id, false);
            return { response: reframeResponse(currentResponse), accountId: account.id, attempts };
          }
        }
      } catch (error) {
        clearTimeout(timeoutId);
        if (error instanceof ProviderResponseError) throw error;
        const aborted = (error as { name?: string })?.name === 'AbortError';
        console.error(
          aborted
            ? `[codex] ${account.label} timed out after ${timeoutMs}ms`
            : `[codex] request failed on ${account.label}: ${String(error).slice(0, 200)}`,
        );
        await updateAccountUsage(account.id, false);
      }
    }

    throw new Error(`Upstream request failed after ${attempts} attempts.`);
  }
}
