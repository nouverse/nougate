/**
 * The models ChatGPT offers a Codex account, from the upstream's own list.
 *
 * `GET <base>/models?client_version=<cliVersion>`, beside `/responses`, with the headers a request
 * carries. The version claimed gates the answer as it gates the models: claiming 0.136.0 lists only
 * Codex's hidden review model, so this asks with the configured `cliVersion`, the one requests
 * claim. Asked of the best account: plans differ, and the one requests go to first is the one whose
 * list matters.
 */

import { fetchModelList, LiveModelList } from '@/core/live-models';
import type { IModelSpec } from '@/core/interfaces';
import { getBestAccount } from '../auth/manager';
import { codexLiveSpecs, codexModelRegistry, type CodexListedModel } from '../config/model-specs';
import { getCodexConfig } from '../config/provider-config';
import { buildHeaders, refreshIfNeeded } from '../upstream/executor';

/** Where the model list lives: the configured Responses URL without its last segment. */
function modelsUrl(): string {
  const { baseUrl, cliVersion } = getCodexConfig();
  const base = baseUrl.replace(/\/+$/, '').replace(/\/responses$/, '');
  return `${base}/models?${new URLSearchParams({ client_version: cliVersion })}`;
}

/** What the upstream offers the best account now, or `null` with no account to ask. */
export async function fetchCodexModels(): Promise<IModelSpec[] | null> {
  const account = await getBestAccount();
  if (!account) return null;
  // Renewed first when near expiry, as a request would be: an idle gateway's timer finds it so.
  await refreshIfNeeded(account);
  const { 'content-type': _body, ...headers } = buildHeaders(account);
  const data = (await fetchModelList(modelsUrl(), { ...headers, accept: 'application/json' })) as {
    models?: CodexListedModel[];
  } | null;
  if (!Array.isArray(data?.models)) throw new Error('the answer carries no `models` list');
  return codexLiveSpecs(data.models);
}

/** Asked at start, after an account is added, and every six hours (`core/live-models.ts`). */
export const codexModelList = new LiveModelList({
  provider: 'codex',
  fetch: fetchCodexModels,
  merge: (specs) => codexModelRegistry.mergeLive(specs),
});
