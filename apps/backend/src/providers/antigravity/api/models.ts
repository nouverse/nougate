/**
 * The models Google offers the Antigravity accounts, from each account's `fetchAvailableModels`.
 *
 * Google moves accounts to a new model generation one by one, so every account is asked and the list
 * is the union: a model any account can serve is offered, and selection keeps each request to the
 * accounts whose own list has it (`isModelUnlistedFor`). An account that cannot answer keeps the
 * models its last answer listed for it, rather than taking them from everyone; when none answers, the
 * last list stays (`core/live-models.ts`).
 */

import { LiveModelList } from '@/core/live-models';
import { getAccounts } from '../auth/manager';
import type { AntigravityAccount } from '../auth/types';
import { antigravityModelRegistry, antigravitySpecs, parseListedModels, type AntigravityListedModel } from '../config/model-specs';
import { requestAvailableModels } from './quota';

/** What the last good answer listed, by Google's id: what an account that cannot answer still has. */
const lastListed = new Map<string, AntigravityListedModel>();

/** What the accounts are offered now, or `null` with no account to ask. */
export async function fetchAntigravityModels(): Promise<AntigravityListedModel[] | null> {
  const accounts = getAccounts().filter((account) => account.projectId && account.refreshToken);
  if (accounts.length === 0) return null;

  const replies = await Promise.allSettled(accounts.map((account) => requestAvailableModels(account)));
  const listed = new Map<string, AntigravityListedModel>();
  const silent: AntigravityAccount[] = [];
  let failure: unknown;
  replies.forEach((reply, index) => {
    if (reply.status === 'fulfilled') {
      for (const model of parseListedModels(reply.value)) if (!listed.has(model.id)) listed.set(model.id, model);
    } else {
      failure ??= reply.reason;
      silent.push(accounts[index]!);
    }
  });
  if (silent.length === accounts.length) throw failure;

  for (const account of silent) {
    for (const id of account.availableModels ?? []) {
      const kept = lastListed.get(id);
      if (kept && !listed.has(id)) listed.set(id, kept);
    }
  }
  return [...listed.values()];
}

/** Asked at start, after an account is added, and every six hours (`core/live-models.ts`). */
export const antigravityModelList = new LiveModelList({
  provider: 'antigravity',
  fetch: fetchAntigravityModels,
  merge: (models) => {
    lastListed.clear();
    for (const model of models) lastListed.set(model.id, model);
    return antigravityModelRegistry.mergeLive(antigravitySpecs(models));
  },
});
