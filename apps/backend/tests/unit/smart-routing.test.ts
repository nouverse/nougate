/**
 * Routing a model that named no provider, and what happens when the first choice cannot serve it.
 *
 * Two failures these cover that cost real requests before they were written:
 *
 *   - Discovery through `getSpec()` instead of `listModelIds()`. A custom provider with
 *     `bypassModelValidation` answers `getSpec()` for *every* model id, so it matches everything and
 *     swallows every unprefixed request regardless of what it actually serves.
 *   - Failing over only on a thrown error. Antigravity does not throw when its quota is spent — it
 *     returns a 429 with an `attempts` array — so a healthy second provider sat unused while the
 *     caller was told "Quota Exhausted".
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { IAccount, IModelSpec, IProvider, ProviderExecuteParams } from '@/core/interfaces';
import type { JitterConfig } from '@/core/jitter';
import { registerProvider, unregisterProvider } from '@/core/registry';
import { resolveModel } from '@/core/model-resolver';
import { explainNoCandidate, routeCandidates, smartRoutableModels } from '@/core/smart-routing';
import { executeWithFailover } from '@/core/provider-execute';
import { ProviderResponseError } from '@/core/upstream-errors';

// The real field names: a mistyped config falls through to DEFAULT_JITTER_CONFIG, which is
// deliberately non-zero, and every case here would sit through a second of it.
const NO_JITTER: JitterConfig = { jitterEnabled: false, jitterMinMs: 0, jitterMaxMs: 0 };

function spec(modelId: string): IModelSpec {
  return {
    modelId,
    displayName: modelId,
    pool: 'cli',
    isThinking: false,
    maxOutputTokens: 1024,
    upstreamModelId: modelId,
    timeoutMs: 1000,
  };
}

interface FakeOptions {
  models: string[];
  accounts?: number;
  /** Stands in for `bypassModelValidation`: says yes to any model id asked of `getSpec`. */
  specForAnything?: boolean;
  execute?: (params: ProviderExecuteParams) => Promise<Response>;
}

const registered: string[] = [];

function fakeProvider(id: string, options: FakeOptions): IProvider {
  const accounts: IAccount[] = Array.from({ length: options.accounts ?? 1 }, (_, i) => ({
    id: `${id}-${i}`,
    providerId: id,
    healthScore: 100,
    lastUsed: 0,
  }));

  const provider: IProvider = {
    id,
    displayName: id,
    init: async () => {},
    getJitterConfig: () => NO_JITTER,
    getBestAccount: async () => accounts[0] ?? null,
    updateAccountUsage: async () => {},
    getAccounts: () => accounts,
    getModelRegistry: () => ({
      getSpec: (modelId: string) =>
        options.models.includes(modelId) || options.specForAnything ? spec(modelId) : null,
      listModelIds: () => [...options.models],
    }),
    getSupportedModels: () => [...options.models],
    execute: options.execute ?? (async () => new Response('ok')),
  };

  registerProvider(provider);
  registered.push(id);
  return provider;
}

afterEach(() => {
  while (registered.length > 0) unregisterProvider(registered.pop()!);
});

describe('picking providers for a model', () => {
  test('an explicit prefix resolves to that provider and no other', () => {
    fakeProvider('alpha', { models: ['shared-model'] });
    fakeProvider('beta', { models: ['shared-model'] });

    const candidates = routeCandidates(resolveModel('beta:shared-model'));
    expect(candidates.map((c) => c.provider.id)).toEqual(['beta']);
  });

  test('an explicit prefix naming a model that provider lacks resolves to nothing', () => {
    fakeProvider('alpha', { models: ['only-here'] });
    fakeProvider('beta', { models: ['something-else'] });

    expect(routeCandidates(resolveModel('beta:only-here'))).toEqual([]);
  });

  test('a bare model fans out to everyone that declares it, in registration order', () => {
    fakeProvider('alpha', { models: ['shared-model'] });
    fakeProvider('beta', { models: ['shared-model'] });
    fakeProvider('gamma', { models: ['unrelated'] });

    const candidates = routeCandidates(resolveModel('shared-model'));
    expect(candidates.map((c) => c.provider.id)).toEqual(['alpha', 'beta']);
  });

  test('a provider holding no accounts is not a candidate', () => {
    fakeProvider('alpha', { models: ['shared-model'], accounts: 0 });
    fakeProvider('beta', { models: ['shared-model'] });

    expect(routeCandidates(resolveModel('shared-model')).map((c) => c.provider.id)).toEqual(['beta']);
  });

  test('a provider that answers getSpec for anything only matches what it declares', () => {
    // The custom-provider trap. Discovery asks the catalogue, so "yes to everything" earns nothing.
    fakeProvider('catchall', { models: ['declared-model'], specForAnything: true });
    fakeProvider('real', { models: ['shared-model'] });

    expect(routeCandidates(resolveModel('shared-model')).map((c) => c.provider.id)).toEqual(['real']);
    expect(routeCandidates(resolveModel('declared-model')).map((c) => c.provider.id)).toEqual([
      'catchall',
    ]);
  });
});

describe('the smart-routable catalogue the picker offers', () => {
  test('lists only models more than one provider can serve, with those providers in order', () => {
    fakeProvider('alpha', { models: ['shared-model', 'alpha-only'] });
    fakeProvider('beta', { models: ['shared-model'] });

    const routable = smartRoutableModels();
    expect([...routable.keys()]).toEqual(['shared-model']);
    expect(routable.get('shared-model')).toEqual(['alpha', 'beta']);
  });

  test('a model whose second provider has no accounts drops off the list', () => {
    // Otherwise the picker offers "smart routing" for a model with exactly one real candidate.
    fakeProvider('alpha', { models: ['shared-model'] });
    fakeProvider('beta', { models: ['shared-model'], accounts: 0 });

    expect(smartRoutableModels().has('shared-model')).toBe(false);
  });

  test('agrees with routeCandidates rather than keeping its own rules', () => {
    fakeProvider('alpha', { models: ['shared-model'] });
    fakeProvider('beta', { models: ['shared-model'] });
    fakeProvider('catchall', { models: ['declared'], specForAnything: true });

    for (const [modelId, providerIds] of smartRoutableModels()) {
      expect(routeCandidates(resolveModel(modelId)).map((c) => c.provider.id)).toEqual(providerIds);
    }
  });
});

describe('explaining a model that routed nowhere', () => {
  test('names the providers that serve it when the problem is missing accounts', () => {
    fakeProvider('alpha', { models: ['shared-model'], accounts: 0 });

    const message = explainNoCandidate(resolveModel('shared-model'));
    expect(message).toContain('alpha');
    expect(message).toContain('account');
    // Actionable: it hands back a model string that would work once an account exists.
    expect(message).toContain('alpha:shared-model');
  });

  test('suggests near misses without ever routing to one', () => {
    fakeProvider('alpha', { models: ['claude-sonnet-4-6-thinking'] });

    const message = explainNoCandidate(resolveModel('claude-sonnet-4-6'));
    expect(message).toContain('alpha:claude-sonnet-4-6-thinking');
    // A suggestion, not a redirect — the lookup itself still found nothing.
    expect(routeCandidates(resolveModel('claude-sonnet-4-6'))).toEqual([]);
  });
});

describe('failing over between providers', () => {
  const params = (): any => ({ protocol: 'openai', body: {}, resolvedModel: resolveModel('m'), ctx: {} });

  test('the first candidate that answers wins, and later ones are never called', async () => {
    let secondCalled = false;
    fakeProvider('alpha', { models: ['m'], execute: async () => new Response('from alpha') });
    fakeProvider('beta', {
      models: ['m'],
      execute: async () => {
        secondCalled = true;
        return new Response('from beta');
      },
    });

    const served = await executeWithFailover(routeCandidates(resolveModel('m')), params);
    expect(served.provider.id).toBe('alpha');
    expect(await served.response.text()).toBe('from alpha');
    expect(secondCalled).toBe(false);
  });

  test('a thrown failure moves to the next provider', async () => {
    fakeProvider('alpha', {
      models: ['m'],
      execute: async () => {
        throw new Error('every credential is cooling down');
      },
    });
    fakeProvider('beta', { models: ['m'], execute: async () => new Response('from beta') });

    const served = await executeWithFailover(routeCandidates(resolveModel('m')), params);
    expect(served.provider.id).toBe('beta');
  });

  test('a returned 429 moves on too — the shape Antigravity uses when its quota is spent', async () => {
    fakeProvider('alpha', {
      models: ['m'],
      execute: async () => new Response(JSON.stringify({ error: 'quota' }), { status: 429 }),
    });
    fakeProvider('beta', { models: ['m'], execute: async () => new Response('from beta') });

    const served = await executeWithFailover(routeCandidates(resolveModel('m')), params);
    expect(served.provider.id).toBe('beta');
    expect(await served.response.text()).toBe('from beta');
  });

  test('a 400 stops the search, because every provider refuses the same body', async () => {
    let secondCalled = false;
    fakeProvider('alpha', {
      models: ['m'],
      execute: async () => new Response('malformed', { status: 400 }),
    });
    fakeProvider('beta', {
      models: ['m'],
      execute: async () => {
        secondCalled = true;
        return new Response('from beta');
      },
    });

    const served = await executeWithFailover(routeCandidates(resolveModel('m')), params);
    expect(served.response.status).toBe(400);
    expect(secondCalled).toBe(false);
  });

  test('a thrown request-fault stops the search as well', async () => {
    let secondCalled = false;
    fakeProvider('alpha', {
      models: ['m'],
      execute: async () => {
        throw new ProviderResponseError('bad body', { status: 400, clientCode: 'upstream_error' });
      },
    });
    fakeProvider('beta', {
      models: ['m'],
      execute: async () => {
        secondCalled = true;
        return new Response('from beta');
      },
    });

    await expect(executeWithFailover(routeCandidates(resolveModel('m')), params)).rejects.toThrow(
      'bad body',
    );
    expect(secondCalled).toBe(false);
  });

  test('when every candidate fails, the first failure is what the caller sees', async () => {
    fakeProvider('alpha', { models: ['m'], execute: async () => new Response('alpha said no', { status: 429 }) });
    fakeProvider('beta', { models: ['m'], execute: async () => new Response('beta said no', { status: 503 }) });

    const served = await executeWithFailover(routeCandidates(resolveModel('m')), params);
    // The operator's first-ordered provider, so the error does not change with how far the fan-out got.
    expect(served.provider.id).toBe('alpha');
    expect(await served.response.text()).toBe('alpha said no');
  });

  test('discarded responses have their bodies cancelled rather than left open', async () => {
    let betaCancelled = false;
    fakeProvider('alpha', { models: ['m'], execute: async () => new Response('a', { status: 429 }) });
    fakeProvider('beta', {
      models: ['m'],
      execute: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('b'));
            },
            cancel() {
              betaCancelled = true;
            },
          }),
          { status: 503 },
        ),
    });

    await executeWithFailover(routeCandidates(resolveModel('m')), params);
    expect(betaCancelled).toBe(true);
  });

  test('every candidate throwing rethrows rather than inventing a response', async () => {
    fakeProvider('alpha', {
      models: ['m'],
      execute: async () => {
        throw new Error('alpha unreachable');
      },
    });
    fakeProvider('beta', {
      models: ['m'],
      execute: async () => {
        throw new Error('beta unreachable');
      },
    });

    await expect(executeWithFailover(routeCandidates(resolveModel('m')), params)).rejects.toThrow(
      /unreachable/,
    );
  });
});
