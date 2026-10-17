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
import { executeWithFailover, FailoverError, failoverHeaders, failureOf } from '@/core/provider-execute';
import { ProviderResponseError } from '@/core/upstream-errors';
import { withCorsHeaders } from '@/router/middleware';

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
  jitter?: JitterConfig;
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
    getJitterConfig: () => options.jitter ?? NO_JITTER,
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

describe('the routing table the picker is built from', () => {
  test('covers every servable bare id, with its providers in the order routing tries them', () => {
    fakeProvider('alpha', { models: ['shared-model', 'alpha-only'] });
    fakeProvider('beta', { models: ['shared-model'] });

    const routable = smartRoutableModels();
    expect([...routable.keys()].sort()).toEqual(['alpha-only', 'shared-model']);
    expect(routable.get('shared-model')).toEqual(['alpha', 'beta']);
    // One candidate is still a route — it just has nowhere to fail over to.
    expect(routable.get('alpha-only')).toEqual(['alpha']);
  });

  test('a provider with no accounts drops out, so its models can lose their only candidate', () => {
    fakeProvider('alpha', { models: ['shared-model'] });
    fakeProvider('beta', { models: ['shared-model', 'beta-only'], accounts: 0 });

    const routable = smartRoutableModels();
    // Down to one candidate, but still routable.
    expect(routable.get('shared-model')).toEqual(['alpha']);
    // Nothing left to serve it, so sending it bare really would fail — and it is absent.
    expect(routable.has('beta-only')).toBe(false);
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

  test('a failover does not wait a second jitter: the request was spaced before its first attempt', async () => {
    const window: JitterConfig = { jitterEnabled: true, jitterMinMs: 300, jitterMaxMs: 300 };
    fakeProvider('alpha', {
      models: ['m'],
      jitter: window,
      execute: async () => new Response(JSON.stringify({ error: 'quota' }), { status: 429 }),
    });
    fakeProvider('beta', { models: ['m'], jitter: window, execute: async () => new Response('from beta') });

    const started = Date.now();
    const served = await executeWithFailover(routeCandidates(resolveModel('m')), params);
    const took = Date.now() - started;
    expect(served.provider.id).toBe('beta');
    expect(took).toBeGreaterThanOrEqual(290);
    expect(took).toBeLessThan(550);
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

  /**
   * "Every provider failed" is the failure an operator most needs explained, and a throw said nothing about who was
   * asked: `served()` sets the headers, and it ran only on a response. The throw now carries them.
   */
  test('every candidate throwing: what is thrown names each provider tried, in order, around the last error', async () => {
    const beta = new Error('beta unreachable');
    fakeProvider('alpha', { models: ['m'], execute: async () => { throw new Error('alpha unreachable'); } });
    fakeProvider('beta', { models: ['m'], execute: async () => { throw beta; } });

    const thrown = await executeWithFailover(routeCandidates(resolveModel('m')), params).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(FailoverError);
    expect((thrown as FailoverError).tried).toEqual(['alpha', 'beta']);
    expect(failureOf(thrown)).toBe(beta);
    expect(failoverHeaders(thrown)).toEqual({ 'x-nougate-attempts': '2', 'x-nougate-tried': 'alpha,beta' });
  });

  test('a throw no other provider would answer differently stops there, and says who was tried', async () => {
    const refusal = new ProviderResponseError('bad body', { status: 400, clientCode: 'upstream_error' });
    fakeProvider('alpha', { models: ['m'], execute: async () => { throw refusal; } });
    fakeProvider('beta', { models: ['m'], execute: async () => new Response('never asked') });

    const thrown = await executeWithFailover(routeCandidates(resolveModel('m')), params).catch((error: unknown) => error);
    expect((thrown as FailoverError).tried).toEqual(['alpha']);
    expect(failureOf(thrown)).toBe(refusal);
  });

  test('an error that did not come out of a failover carries no attribution', () => {
    expect(failoverHeaders(new Error('elsewhere'))).toEqual({});
    expect(failureOf('as it is')).toBe('as it is');
  });
});

/**
 * Who served, said on the response itself (x-nougate-provider, -model, -attempts). A bare model can be served by any
 * provider that has it, the next taking over when one fails, and the body does not name the provider on every path —
 * so a client keeping its own accounting could not split it by what ran.
 */
describe('saying who served', () => {
  const params = (): any => ({ protocol: 'openai', body: {}, resolvedModel: resolveModel('m'), ctx: {} });
  const said = (response: Response) =>
    Object.fromEntries(['x-nougate-provider', 'x-nougate-model', 'x-nougate-attempts'].map((name) => [name, response.headers.get(name)]));

  test('the provider, the model as it names it, and one attempt when the first answered', async () => {
    fakeProvider('alpha', { models: ['m'], execute: async () => new Response('from alpha', { headers: { 'x-request-id': 'req_1' } }) });
    const served = await executeWithFailover(routeCandidates(resolveModel('m')), params);
    expect(said(served.response)).toEqual({ 'x-nougate-provider': 'alpha', 'x-nougate-model': 'm', 'x-nougate-attempts': '1' });
    // What the provider said is kept, and so is the body.
    expect(served.response.headers.get('x-request-id')).toBe('req_1');
    expect(await served.response.text()).toBe('from alpha');
  });

  test('after a failover, the provider that answered and how many were tried', async () => {
    fakeProvider('alpha', { models: ['m'], execute: async () => new Response('quota', { status: 429 }) });
    fakeProvider('beta', { models: ['m'], execute: async () => { throw new Error('cooling down'); } });
    fakeProvider('gamma', { models: ['m'], execute: async () => new Response('from gamma') });
    const served = await executeWithFailover(routeCandidates(resolveModel('m')), params);
    expect(said(served.response)).toEqual({ 'x-nougate-provider': 'gamma', 'x-nougate-model': 'm', 'x-nougate-attempts': '3' });
    expect(served.response.headers.get('x-nougate-tried')).toBe('alpha,beta,gamma');
  });

  test('when every one failed, the failure handed back says whose it is and that all were tried', async () => {
    fakeProvider('alpha', { models: ['m'], execute: async () => new Response('alpha said no', { status: 429 }) });
    fakeProvider('beta', { models: ['m'], execute: async () => new Response('beta said no', { status: 503 }) });
    const served = await executeWithFailover(routeCandidates(resolveModel('m')), params);
    expect(served.response.status).toBe(429);
    expect(said(served.response)).toEqual({ 'x-nougate-provider': 'alpha', 'x-nougate-model': 'm', 'x-nougate-attempts': '2' });
    expect(served.response.headers.get('x-nougate-tried')).toBe('alpha,beta');
  });

  test("an upstream's own response handed back is reframed: its encoding is not the body's any more", async () => {
    fakeProvider('alpha', {
      models: ['m'],
      execute: async () => new Response('plain text', { headers: { 'content-encoding': 'gzip', 'content-length': '999' } }),
    });
    const served = await executeWithFailover(routeCandidates(resolveModel('m')), params);
    expect(served.response.headers.get('content-encoding')).toBeNull();
    expect(served.response.headers.get('content-length')).not.toBe('999');
    expect(served.response.headers.get('x-nougate-provider')).toBe('alpha');
    expect(await served.response.text()).toBe('plain text');
  });

  test('a browser client may read them', () => {
    const headers = withCorsHeaders(new Response('x')).headers.get('access-control-expose-headers') ?? '';
    expect(headers.split(',').map((name) => name.trim())).toEqual(['x-nougate-provider', 'x-nougate-model', 'x-nougate-attempts', 'x-nougate-tried']);
  });
});
