/**
 * Kiro upstream executor — one request, with however many credentials and surfaces it takes.
 *
 * Per account: renew the token if it is about to expire, then walk the chat surfaces in the order
 * `endpoints.ts` gives for that auth method. A surface that refuses the token (401/403/404) hands on
 * to the next; a refusal from all of them earns one reactive renewal and a second pass. Throttling
 * benches the account for the model and moves to the next account; a 400 is the request's fault and
 * ends the attempt for everyone.
 *
 * A 200 is not yet success. Kiro reports throttling and expired tokens *inside* the EventStream as
 * exception frames, so the stream is primed — read up to its first client-visible event — before
 * this returns. A refusal found there is handled exactly like the HTTP one, because nothing has
 * reached the client yet. After this returns, nothing can be retried.
 */

import type { IModelSpec } from '@/core/interfaces';
import { ProviderResponseError, ProviderUnavailableError, upstreamMessage } from '@/core/upstream-errors';
import { kiroAccounts, cooldownScope, ACCOUNT_WIDE, type KiroAccountPool } from '../auth/manager';
import { fetchProfileArn } from '../auth/profile';
import { KiroRefreshError, canRefresh, needsRefresh, refreshKiroTokens } from '../auth/refresh';
import type { KiroAccount } from '../auth/types';
import type { PreparedKiroRequest } from '../mappers/payload';
import { KiroStreamInterpreter, type KiroEvent } from '../mappers/stream-events';
import { getKiroConfig } from '../config/provider-config';
import { SURFACE_FALLBACK_STATUSES, chatEndpoints } from './endpoints';
import { buildChatHeaders } from './headers';
import { KiroResponseReader } from './stream-reader';

const MAX_ACCOUNT_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 600_000;
/** How long an account sits out after its token could not be renewed for a transient reason. */
const REFRESH_RETRY_COOLDOWN_MS = 30_000;

export interface KiroExecuteOptions {
  prepared: PreparedKiroRequest;
  modelSpec: IModelSpec;
  clientId?: string;
  /** The client's request signal: a caller that hung up should not keep an upstream call open. */
  signal?: AbortSignal;
}

export interface KiroExecuteResult {
  reader: KiroResponseReader;
  primed: KiroEvent[];
  accountId: string;
  attempts: number;
}

/** Renew ahead of expiry, quietly. A permanent refusal ends the account; anything else is tried anyway. */
export async function ensureFreshCredential(
  account: KiroAccount,
  pool: KiroAccountPool = kiroAccounts,
): Promise<'ok' | 'invalid' | 'cooling'> {
  if (!needsRefresh(account)) return 'ok';
  try {
    await renew(account, pool);
    return 'ok';
  } catch (error) {
    if (error instanceof KiroRefreshError && error.permanent) {
      pool.invalidate(account.id, `refresh token rejected — sign in again (${error.status})`);
      console.error(`[kiro] ${account.label} can no longer renew itself — sign in again`);
      return 'invalid';
    }
    console.warn(`[kiro] could not renew ${account.label} ahead of expiry: ${(error as Error).message.slice(0, 200)}`);
    // Still valid until it actually expires; only bench it once it has.
    if (account.expiresAt !== undefined && account.expiresAt <= Date.now()) {
      pool.markCooldown(account.id, ACCOUNT_WIDE, REFRESH_RETRY_COOLDOWN_MS);
      return 'cooling';
    }
    return 'ok';
  }
}

async function renew(account: KiroAccount, pool: KiroAccountPool): Promise<void> {
  const tokens = await refreshKiroTokens(account);
  pool.storeTokens(account.id, tokens);
  if (!account.profileArn && account.authMethod !== 'api_key') {
    const arn = await fetchProfileArn(account).catch(() => null);
    if (arn) pool.setProfileArn(account.id, arn);
  }
}

function retryAfterMs(response: Response): number | undefined {
  const seconds = Number(response.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

type SurfaceOutcome =
  | { kind: 'success'; reader: KiroResponseReader; primed: KiroEvent[] }
  | { kind: 'auth'; status: number }
  | { kind: 'throttled'; waitMs?: number }
  | { kind: 'server'; status?: number; message: string };

export class KiroExecutor {
  constructor(private readonly pool: KiroAccountPool = kiroAccounts) {}

  async execute(options: KiroExecuteOptions): Promise<KiroExecuteResult> {
    const { prepared, modelSpec } = options;
    const modelId = modelSpec.modelId;
    const scope = cooldownScope(modelId);
    const timeoutMs = modelSpec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const tried: string[] = [];
    let attempts = 0;

    while (attempts < MAX_ACCOUNT_ATTEMPTS) {
      const account = this.pool.best({ modelId, excludeIds: tried, clientId: options.clientId });
      if (!account) break;
      tried.push(account.id);
      attempts++;

      const freshness = await ensureFreshCredential(account, this.pool);
      if (freshness !== 'ok') continue;

      // May throw a 400 for a conversation Kiro cannot represent — the caller's problem, not the account's.
      const payload = JSON.stringify(prepared.forAccount(account));

      let outcome = await this.trySurfaces(account, payload, prepared, timeoutMs, options.signal);
      if (outcome.kind === 'auth' && canRefresh(account)) {
        const refusedWith = outcome.status;
        try {
          await renew(account, this.pool);
          console.warn(`[kiro] renewed ${account.label} after a ${refusedWith}`);
          outcome = await this.trySurfaces(account, payload, prepared, timeoutMs, options.signal);
        } catch (error) {
          if (error instanceof KiroRefreshError && error.permanent) {
            this.pool.invalidate(account.id, `refresh token rejected — sign in again (${error.status})`);
          } else {
            this.pool.markCooldown(account.id, ACCOUNT_WIDE, REFRESH_RETRY_COOLDOWN_MS);
          }
          this.pool.recordResult(account.id, false, { modelId, status: refusedWith });
          continue;
        }
      }

      switch (outcome.kind) {
        case 'success':
          this.pool.recordResult(account.id, true, { modelId, clientId: options.clientId });
          return { reader: outcome.reader, primed: outcome.primed, accountId: account.id, attempts };

        case 'auth':
          if (outcome.status === 401) {
            this.pool.invalidate(account.id, 'every Kiro surface rejected the token, and renewing it did not help');
          } else {
            // 403 can also mean "no entitlement for this model": bench, do not condemn.
            this.pool.markCooldown(account.id, scope);
          }
          this.pool.recordResult(account.id, false, { modelId, status: outcome.status });
          console.warn(`[kiro] ${account.label} refused by every surface (${outcome.status})`);
          continue;

        case 'throttled':
          this.pool.markCooldown(account.id, scope, outcome.waitMs);
          this.pool.recordResult(account.id, false, { modelId, status: 429 });
          console.warn(`[kiro] ${account.label} throttled on ${modelId}`);
          continue;

        case 'server':
          this.pool.recordResult(account.id, false, { modelId, status: outcome.status });
          console.warn(`[kiro] ${account.label} failed on every surface: ${outcome.message.slice(0, 200)}`);
          continue;
      }
    }

    if (tried.length === 0) {
      throw new ProviderUnavailableError(
        this.pool.list().length === 0
          ? 'No Kiro accounts are configured. Add one on the provider page.'
          : 'Every Kiro account is cooling down or needs to sign in again.',
        503,
      );
    }
    throw new ProviderUnavailableError(`Every Kiro account tried failed (${tried.length} tried).`, 503);
  }

  private async trySurfaces(
    account: KiroAccount,
    payload: string,
    prepared: PreparedKiroRequest,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<SurfaceOutcome> {
    let last: SurfaceOutcome = { kind: 'server', message: 'no surface answered' };

    for (const endpoint of chatEndpoints(account)) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error(`no answer after ${timeoutMs}ms`)), timeoutMs);
      const forwardAbort = () => controller.abort(signal?.reason);
      signal?.addEventListener('abort', forwardAbort, { once: true });

      let response: Response;
      try {
        response = await fetch(endpoint.url, {
          method: 'POST',
          headers: buildChatHeaders(account, endpoint.surface),
          body: payload,
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timer);
        signal?.removeEventListener('abort', forwardAbort);
        if (signal?.aborted) throw error;
        last = { kind: 'server', message: `${endpoint.surface}: ${(error as Error).message}` };
        continue;
      }
      // Headers are in: from here the stream's own idle timeout governs, not the connect timeout.
      clearTimeout(timer);

      if (response.ok && response.body) {
        const interpreter = new KiroStreamInterpreter({
          inlineThinking: prepared.inlineThinking,
          toolNameMap: prepared.toolNameMap,
          contextWindow: prepared.contextWindow,
          maxToolInputBytes: getKiroConfig().maxToolInputBytes,
        });
        const reader = new KiroResponseReader(response.body, interpreter);
        const primed = await reader.prime();
        const first = primed[0];

        if (first?.type === 'error' && !interpreter.hasEmittedOutput) {
          await reader.cancel('kiro refused in-stream');
          signal?.removeEventListener('abort', forwardAbort);
          if (first.status === 429 || first.status === 503) return { kind: 'throttled' };
          if (first.status === 401 || first.status === 403) {
            last = { kind: 'auth', status: first.status };
            continue;
          }
          if (first.status === 400) {
            throw new ProviderResponseError(first.message, { status: 400, clientCode: 'upstream_error' });
          }
          return { kind: 'server', status: first.status, message: `${endpoint.surface}: ${first.message}` };
        }
        // The client's abort now reaches upstream by cancelling the stream, not through this signal.
        signal?.removeEventListener('abort', forwardAbort);
        return { kind: 'success', reader, primed };
      }

      signal?.removeEventListener('abort', forwardAbort);
      const text = await response.text().catch(() => '');

      if (SURFACE_FALLBACK_STATUSES.has(response.status)) {
        // A 404 is "this front door has no such route", not an auth verdict; it only counts as one
        // when no surface ever answers otherwise.
        if (last.kind !== 'auth' || response.status !== 404) last = { kind: 'auth', status: response.status };
        continue;
      }
      if (response.status === 429) return { kind: 'throttled', waitMs: retryAfterMs(response) };
      if (response.status === 400 || response.status === 413 || response.status === 422) {
        console.error(`[kiro] ${response.status} from ${endpoint.surface}: ${text.slice(0, 300)}`);
        throw new ProviderResponseError(upstreamMessage(text, 'Kiro refused the request'), {
          status: response.status,
          clientCode: 'upstream_error',
        });
      }
      last = { kind: 'server', status: response.status, message: `${endpoint.surface}: ${response.status} ${text.slice(0, 200)}` };
    }
    return last;
  }
}
