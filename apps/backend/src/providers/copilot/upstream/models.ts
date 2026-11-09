/**
 * The models Copilot offers an account, from `GET https://api.githubcopilot.com/models`.
 *
 * Asked with the session token a request uses (`ensureSessionToken`: the cached one while it is
 * fresh, else exchanged for the account's GitHub token) and the headers a request carries.
 */

import { fetchModelList, LiveModelList } from '@/core/live-models';
import type { IModelSpec } from '@/core/interfaces';
import { getAccounts } from '../auth/manager';
import { ensureSessionToken } from '../auth/token-exchange';
import type { CopilotAccount } from '../auth/types';
import { copilotLiveSpecs, copilotModelRegistry, type CopilotListedModel } from '../config/model-specs';
import { getCopilotHeaders } from './headers';

const MODELS_URL = 'https://api.githubcopilot.com/models';

/**
 * The healthiest account Copilot has not marked invalid. Not selection's own pick: that one also
 * saves the pool and benches an account whose exchange fails, which a model list has no cause to do.
 */
function healthiestAccount(): CopilotAccount | null {
  const usable = getAccounts().filter((account) => account.personalToken && account.status !== 'invalid');
  return usable.sort((a, b) => b.healthScore - a.healthScore)[0] ?? null;
}

/** What Copilot offers the healthiest account now, or `null` with no account to ask. */
export async function fetchCopilotModels(): Promise<IModelSpec[] | null> {
  const account = healthiestAccount();
  if (!account) return null;
  const sessionToken = await ensureSessionToken(account);
  const { 'Content-Type': _body, ...headers } = getCopilotHeaders(sessionToken);
  const data = (await fetchModelList(MODELS_URL, { ...headers, Accept: 'application/json' })) as {
    data?: CopilotListedModel[];
  } | null;
  if (!Array.isArray(data?.data)) throw new Error('the answer carries no `data` list');
  return copilotLiveSpecs(data.data);
}

/** Asked at start, after an account is added, and every six hours (`core/live-models.ts`). */
export const copilotModelList = new LiveModelList({
  provider: 'copilot',
  fetch: fetchCopilotModels,
  merge: (specs) => copilotModelRegistry.mergeLive(specs),
});
