import { type IModelSpec } from '@/core/interfaces';
import { type CopilotAccount } from '../auth/types';
import { getBestAccount, updateAccountUsage, markCooldown, cooldownScope } from '../auth/manager';
import { classifyUpstreamError, ModelUnavailableError, ProviderResponseError } from '@/core/upstream-errors';
import { getCopilotHeaders } from './headers';
import { getProxyConfig } from '@/config/manager';

export interface CopilotExecuteOptions {
  body: any;
  modelSpec: IModelSpec;
  clientId?: string;
}

export interface CopilotExecuteResult {
  response: Response;
  accountId: string;
  attempts: number;
}

export class CopilotExecutor {
  async execute(options: CopilotExecuteOptions): Promise<CopilotExecuteResult> {
    const proxyConfig = getProxyConfig();
    const maxAttempts = Math.max(proxyConfig?.retry?.maxAttempts || 3, 3);
    const modelId = options.modelSpec.modelId;
    const upstreamModelId = options.modelSpec.upstreamModelId || modelId;

    let attempts = 0;
    const triedIds: string[] = [];
    let account: CopilotAccount | null = null;
    /** The last "model not offered" answer: given to the client when no other account is left. */
    let modelRefusal: ModelUnavailableError | undefined;

    while (attempts < maxAttempts) {
      attempts++;
      
      account = await getBestAccount(options.modelSpec.pool, modelId, options.clientId, triedIds, true);
      if (!account) {
        account = await getBestAccount(options.modelSpec.pool, modelId, options.clientId, triedIds, false);
      }

      if (!account || !account.sessionToken) {
        if (modelRefusal) throw modelRefusal;
        if (triedIds.length > 0 && attempts < maxAttempts) {
          triedIds.length = 0;
          continue;
        }
        throw new Error('No Copilot accounts available or session token exchange failed.');
      }

      triedIds.push(account.id);

      // Upstream expects the exact model name it supports
      const requestBody = {
        ...options.body,
        model: upstreamModelId,
      };

      const timeoutMs = options.modelSpec.timeoutMs ?? 60_000;
      const controller = new AbortController();
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      try {
        // Jitter is applied once per request by `executeProviderRequest`, before
        // this executor is reached, so the floor an operator sets in
        // BOTTOM_JITTER cannot be reimplemented away here.
        //
        // Every model spec declares a timeoutMs and nothing used to read it,
        // so a stalled upstream connection hung the request forever — the
        // server runs with idleTimeout disabled, so nothing else would cut it.
        timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        const response = await fetch('https://api.githubcopilot.com/chat/completions', {
          method: 'POST',
          headers: getCopilotHeaders(account.sessionToken),
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (response.status === 401) {
          console.warn(`[Copilot Upstream] Account ${account.id} unauthorized (401). Marking invalid.`);
          await updateAccountUsage(account.id, false, modelId, options.modelSpec.pool, options.clientId, 401);
          continue;
        }

        if (response.status === 429) {
          // Read the body so a spent allowance can be told apart from a speed
          // limit — the two deserve very different cooldowns.
          const body = await response.text().catch(() => '');
          const { kind, message } = classifyUpstreamError({ status: 429, body });
          console.warn(`[Copilot Upstream] Account ${account.id}: ${message} (${kind})`);
          markCooldown(account.id, options.modelSpec.pool, cooldownScope(modelId), '60s', kind);
          await updateAccountUsage(account.id, false, modelId, options.modelSpec.pool, options.clientId, 429);
          continue;
        }

        if (!response.ok) {
          const errText = await response.text();
          const classification = classifyUpstreamError({ status: response.status, body: errText });
          console.error(
            `[Copilot Upstream] ${response.status} from upstream (${classification.kind}): ${errText.slice(0, 300)}`,
          );

          // Every Copilot account queries the same model catalogue, so a model
          // it does not know is not this account's fault and no other account
          // will answer differently. Rotating through them all dropped the
          // health score of every healthy account over a caller's typo, then
          // reported it as "failed after N attempts" — hiding the real cause.
          // A model this account's seat is not offered may be on another's: the next eligible account
          // is asked, and this one loses nothing. The refusal is the answer only once none is left.
          if (classification.kind === 'model_unsupported') {
            modelRefusal = new ModelUnavailableError(
              `GitHub Copilot does not offer "${modelId}". Check the model list on the provider page.`,
            );
            continue;
          }

          await updateAccountUsage(account.id, false, modelId, options.modelSpec.pool, options.clientId, response.status);
          continue;
        }

        // Request successful
        await updateAccountUsage(account.id, true, modelId, options.modelSpec.pool, options.clientId, 200);
        return {
          response,
          accountId: account.id,
          attempts,
        };

      } catch (error: any) {
        clearTimeout(timeoutId);
        // A failure already named for the client (the model is not offered here) is the request's:
        // thrown on, not charged. Caught here, it was charged to the account as a 500 and asked again
        // until the attempts ran out, and the client read "failed after N attempts".
        if (error instanceof ProviderResponseError) throw error;
        if (error?.name === 'AbortError') {
          console.error(`[Copilot Upstream] Account ${account.id} timed out after ${timeoutMs}ms`);
        } else {
          console.error(`[Copilot Upstream] Request failed on account ${account.id}:`, error);
        }
        await updateAccountUsage(account.id, false, modelId, options.modelSpec.pool, options.clientId, 500);
      }
    }

    if (modelRefusal) throw modelRefusal;
    throw new Error(`Upstream request failed after ${attempts} attempts.`);
  }
}
