import { type IModelSpec } from '@/core/interfaces';
import { type CopilotAccount } from '../auth/types';
import { getBestAccount, updateAccountUsage, markCooldown } from '../auth/manager';
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

    while (attempts < maxAttempts) {
      attempts++;
      
      account = await getBestAccount(options.modelSpec.pool, modelId, options.clientId, triedIds, true);
      if (!account) {
        account = await getBestAccount(options.modelSpec.pool, modelId, options.clientId, triedIds, false);
      }

      if (!account || !account.sessionToken) {
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

      try {
        const response = await fetch('https://api.githubcopilot.com/chat/completions', {
          method: 'POST',
          headers: getCopilotHeaders(account.sessionToken),
          body: JSON.stringify(requestBody),
        });

        if (response.status === 401) {
          console.warn(`[Copilot Upstream] Account ${account.id} unauthorized (401). Marking invalid.`);
          await updateAccountUsage(account.id, false, modelId, options.modelSpec.pool, options.clientId, 401);
          continue;
        }

        if (response.status === 429) {
          console.warn(`[Copilot Upstream] Account ${account.id} rate limited (429). Triggering cooldown.`);
          markCooldown(account.id, options.modelSpec.pool, modelId, '60s');
          await updateAccountUsage(account.id, false, modelId, options.modelSpec.pool, options.clientId, 429);
          continue;
        }

        if (!response.ok) {
          const errText = await response.text();
          console.error(`[Copilot Upstream] Error status ${response.status} from upstream: ${errText}`);
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
        console.error(`[Copilot Upstream] Request failed on account ${account.id}:`, error);
        await updateAccountUsage(account.id, false, modelId, options.modelSpec.pool, options.clientId, 500);
      }
    }

    throw new Error(`Upstream request failed after ${attempts} attempts.`);
  }
}
