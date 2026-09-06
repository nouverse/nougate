/**
 * Which provider answers a model that did not name one.
 *
 * A client may send `claude-sonnet-4-6` with no `provider:` prefix. More than one provider can serve
 * that model — today `antigravity` and `claudecode` both declare it — so something has to choose, and
 * something has to try the next one when the first has nothing left to give.
 *
 * ## Discovery reads the catalogue, never `getSpec`
 *
 * A custom provider with `bypassModelValidation` answers `getSpec()` for *any* model id: the upstream
 * is the authority there, so the registry stops guessing. Asking "who has this model?" that way gets
 * a yes from that provider every time, and every unprefixed request lands on it regardless of what it
 * actually serves. `listModelIds()` is the declared catalogue and the only honest question to ask.
 *
 * ## Order is the operator's, not a score
 *
 * Candidates come back in registration order — the sequence in `boot.ts`, which is the same sequence
 * the dashboard sidebar shows. That is deliberately duller than ranking by quota or price: an
 * operator can look at the list and say where a request will go, and a request that lands somewhere
 * surprising is worse than one that lands somewhere merely suboptimal. Providers holding no accounts
 * at all are dropped, because that is availability rather than preference; everything finer-grained
 * is left to failover, which finds out for real instead of predicting.
 */

import type { IModelSpec, IProvider, ResolvedModel } from '@/core/interfaces';
import { getAllProviders, getProvider } from '@/core/registry';

/** One provider that can serve the request, with its own spec for the model. */
export interface RoutingCandidate {
  provider: IProvider;
  modelSpec: IModelSpec;
}

/** Whether this provider has any credential at all. Not whether it will work — that is failover's job. */
function hasAccounts(provider: IProvider): boolean {
  try {
    return provider.getAccounts().length > 0;
  } catch {
    // A provider whose account store failed to load is not a candidate, and is not a reason to fail
    // the whole lookup either.
    return false;
  }
}

/** The declared catalogue, defensively — a provider that throws here simply offers nothing. */
function declaresModel(provider: IProvider, modelId: string): boolean {
  try {
    return provider.getModelRegistry().listModelIds().includes(modelId);
  } catch {
    return false;
  }
}

/**
 * Every provider that can serve this request, best first.
 *
 * A prefixed model resolves to exactly that provider or to nothing — an explicit prefix is an
 * instruction, and quietly serving it from somewhere else would make `provider:model` mean "or
 * wherever". Only an unprefixed model fans out.
 */
export function routeCandidates(resolved: ResolvedModel): RoutingCandidate[] {
  if (resolved.providerId !== null) {
    const provider = getProvider(resolved.providerId);
    if (!provider) return [];
    const modelSpec = provider.getModelRegistry().getSpec(resolved.modelId);
    return modelSpec ? [{ provider, modelSpec }] : [];
  }

  const candidates: RoutingCandidate[] = [];
  for (const provider of getAllProviders()) {
    if (!declaresModel(provider, resolved.modelId)) continue;
    if (!hasAccounts(provider)) continue;
    const modelSpec = provider.getModelRegistry().getSpec(resolved.modelId);
    if (modelSpec) candidates.push({ provider, modelSpec });
  }
  return candidates;
}

/**
 * What to tell a client whose unprefixed model matched nothing.
 *
 * Names the providers that *do* declare it when the only problem was that none of them hold an
 * account — "no provider serves this model" and "the two that serve it have no credentials" are
 * different problems with different fixes, and one message for both sends operators to the wrong one.
 */
export function explainNoCandidate(resolved: ResolvedModel): string {
  if (resolved.providerId !== null) {
    return `Unknown model "${resolved.raw}"`;
  }

  const declaring = getAllProviders()
    .filter((provider) => declaresModel(provider, resolved.modelId))
    .map((provider) => provider.id);

  if (declaring.length > 0) {
    return (
      `"${resolved.modelId}" is served by ${declaring.join(', ')}, but none of them has an account ` +
      `configured. Add one on the provider page, or address a provider directly as ` +
      `"${declaring[0]}:${resolved.modelId}".`
    );
  }

  const suggestions = getAllProviders()
    .flatMap((provider) => {
      try {
        return provider
          .getModelRegistry()
          .listModelIds()
          .filter((id) => id.includes(resolved.modelId) || resolved.modelId.includes(id))
          .map((id) => `${provider.id}:${id}`);
      } catch {
        return [];
      }
    })
    .slice(0, 4);

  // Deliberately no fuzzy matching beyond a substring: a near-miss that silently becomes a different
  // model is worse than an error, so this only ever *suggests* and never routes.
  return suggestions.length > 0
    ? `No provider serves "${resolved.raw}". Did you mean ${suggestions.join(', ')}?`
    : `No provider serves "${resolved.raw}". Call /v1/models for the list.`;
}
