/**
 * The models Anthropic lists for a credential, from `GET /v1/models`.
 *
 * The subscription login reads it too: an OAuth token on `Authorization: Bearer` with the
 * `oauth-2025-04-20` gate (`authHeaders`), and the CLI's identity headers beside it, as on a request.
 * The list is paged (`has_more`, `after_id`); every page is read. Asked of the best credential.
 */

import { fetchModelList, LiveModelList } from '@/core/live-models';
import type { IModelSpec } from '@/core/interfaces';
import { getBestAccount } from '../auth/manager';
import { authHeaders, credentialKind } from '../auth/credential';
import { claudeCodeModelRegistry, claudeLiveSpecs, type ClaudeListedModel } from '../config/model-specs';
import { getClaudeCodeConfig } from '../config/provider-config';
import { CLAUDE_CLI_HEADERS } from '../upstream/client-headers';
import { refreshIfExpiring } from '../upstream/executor';

/** The most a page holds. */
const PAGE_SIZE = 100;

/** Pages read at most, so an upstream that keeps saying `has_more` cannot hold a refresh for good. */
const MAX_PAGES = 10;

interface ModelPage {
  data?: ClaudeListedModel[];
  has_more?: boolean;
  last_id?: string;
}

/** What Anthropic lists for the best credential now, or `null` with no credential to ask. */
export async function fetchClaudeModels(): Promise<IModelSpec[] | null> {
  const account = await getBestAccount();
  if (!account) return null;
  // Renewed first when near expiry, as a request would be: a token lives hours, and an idle
  // gateway's timer would otherwise find it spent.
  await refreshIfExpiring(account);

  const headers: Record<string, string> = {
    ...(credentialKind(account.credential) === 'oauth' ? CLAUDE_CLI_HEADERS : {}),
    ...authHeaders(account.credential),
    accept: 'application/json',
  };
  const base = getClaudeCodeConfig().baseUrl.replace(/\/+$/, '');
  const models: ClaudeListedModel[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = new URLSearchParams({ limit: String(PAGE_SIZE), ...(after ? { after_id: after } : {}) });
    const data = (await fetchModelList(`${base}/v1/models?${query}`, headers)) as ModelPage | null;
    if (!Array.isArray(data?.data)) throw new Error('the answer carries no `data` list');
    models.push(...data.data);
    if (!data.has_more || !data.last_id) break;
    after = data.last_id;
  }
  return claudeLiveSpecs(models);
}

/** Asked at start, after an account is added, and every six hours (`core/live-models.ts`). */
export const claudeCodeModelList = new LiveModelList({
  provider: 'claudecode',
  fetch: fetchClaudeModels,
  merge: (specs) => claudeCodeModelRegistry.mergeLive(specs),
});
