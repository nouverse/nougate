/**
 * Who served a request, as the client receives it: through either protocol's handler, the metrics wrapper and the
 * CORS headers, not only out of `executeWithFailover` (which `smart-routing.test.ts` covers). A header dropped by a
 * layer above would read as a gateway that never says — the state every client was in before.
 */

import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { loadProxyConfig } from '@/config/manager';
import type { IProvider } from '@/core/interfaces';
import type { JitterConfig } from '@/core/jitter';
import { resolveModel } from '@/core/model-resolver';
import { registerProvider, unregisterProvider } from '@/core/registry';
import { ProviderUnavailableError } from '@/core/upstream-errors';
import { AnthropicProtocolHandler } from '@/protocols/anthropic/handler';
import { OpenAIProtocolHandler } from '@/protocols/openai/handler';
import { withCorsHeaders } from '@/router/middleware';

const NO_JITTER: JitterConfig = { jitterEnabled: false, jitterMinMs: 0, jitterMaxMs: 0 };

function provider(id: string, answer: () => Response | Promise<Response>): IProvider {
  const account = { id: `${id}-0`, providerId: id, healthScore: 100, lastUsed: 0 };
  return {
    id,
    displayName: id,
    init: async () => {},
    getJitterConfig: () => NO_JITTER,
    getBestAccount: async () => account,
    updateAccountUsage: async () => {},
    getAccounts: () => [account],
    getModelRegistry: () => ({
      getSpec: (modelId: string) =>
        modelId === 'served-model'
          ? { modelId, displayName: modelId, pool: 'cli', isThinking: false, maxOutputTokens: 1024, upstreamModelId: modelId, timeoutMs: 1000 }
          : null,
      listModelIds: () => ['served-model'],
    }),
    getSupportedModels: () => ['served-model'],
    execute: async () => answer(),
  } as IProvider;
}

// As the other handler tests do: the handlers read the gateway's config.
beforeAll(async () => {
  await loadProxyConfig();
});
afterEach(() => {
  unregisterProvider('alpha');
  unregisterProvider('beta');
});

const said = (response: Response) =>
  ['x-nougate-provider', 'x-nougate-model', 'x-nougate-attempts'].map((name) => response.headers.get(name));

describe('who served, as the client receives it', () => {
  test('through the OpenAI handler', async () => {
    const alpha = provider('alpha', () =>
      Response.json({ id: 'c', object: 'chat.completion', model: 'alpha:served-model', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }),
    );
    registerProvider(alpha);
    const req = new Request('http://localhost:3000/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'alpha:served-model', messages: [{ role: 'user', content: 'hi' }] }),
    });
    const response = withCorsHeaders(
      await new OpenAIProtocolHandler().handle({ req, url: new URL(req.url), protocol: 'openai', resolvedModel: resolveModel('alpha:served-model'), provider: alpha, sessionId: 's', clientId: 'nouride/nouva' }),
    );
    expect(response.status).toBe(200);
    expect(said(response)).toEqual(['alpha', 'served-model', '1']);
  });

  test('through the Anthropic handler', async () => {
    const alpha = provider('alpha', () =>
      Response.json({ id: 'm', type: 'message', role: 'assistant', model: 'alpha:served-model', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }),
    );
    registerProvider(alpha);
    const req = new Request('http://localhost:3000/anthropic/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'alpha:served-model', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
    });
    const response = withCorsHeaders(
      await new AnthropicProtocolHandler().handle({ req, url: new URL(req.url), protocol: 'anthropic', resolvedModel: resolveModel('alpha:served-model'), provider: alpha, sessionId: 's', clientId: 'nouride/nouva' }),
    );
    expect(response.status).toBe(200);
    expect(said(response)).toEqual(['alpha', 'served-model', '1']);
  });
});

/**
 * When no provider answered — each one threw — the error response says which were tried (`x-nougate-tried`,
 * `-attempts`), through both handlers, whatever the error. It carried only Content-Type, CORS and Retry-After, so the
 * failure an operator most needs explained was the one with no attribution.
 */
describe('who was tried, when no provider answered', () => {
  const tried = (response: Response) => ['x-nougate-tried', 'x-nougate-attempts'].map((name) => response.headers.get(name));
  const throwing = (id: string, error: Error) => registerProvider(provider(id, async () => { throw error; }));

  async function viaOpenAI(): Promise<Response> {
    const req = new Request('http://localhost:3000/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'served-model', messages: [{ role: 'user', content: 'hi' }] }),
    });
    return withCorsHeaders(
      await new OpenAIProtocolHandler().handle({ req, url: new URL(req.url), protocol: 'openai', resolvedModel: resolveModel('served-model'), provider: undefined as never, sessionId: 's', clientId: 'nouride/nouva' }),
    );
  }

  async function viaAnthropic(): Promise<Response> {
    const req = new Request('http://localhost:3000/anthropic/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'served-model', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
    });
    return withCorsHeaders(
      await new AnthropicProtocolHandler().handle({ req, url: new URL(req.url), protocol: 'anthropic', resolvedModel: resolveModel('served-model'), provider: undefined as never, sessionId: 's', clientId: 'nouride/nouva' }),
    );
  }

  for (const [name, via] of [['OpenAI', viaOpenAI], ['Anthropic', viaAnthropic]] as const) {
    test(`a 502 through the ${name} handler names both providers it tried`, async () => {
      throwing('alpha', new Error('alpha unreachable'));
      throwing('beta', new Error('beta unreachable'));
      const response = await via();
      expect(response.status).toBe(502);
      expect(tried(response)).toEqual(['alpha,beta', '2']);
      expect(JSON.stringify(await response.json())).toContain('beta unreachable');
      expect(response.headers.get('access-control-expose-headers')).toContain('x-nougate-tried');
    });

    test(`a refusal through the ${name} handler keeps its own status and Retry-After, and names who was tried`, async () => {
      throwing('alpha', new ProviderUnavailableError('alpha is out of quota', 429, 30));
      throwing('beta', new ProviderUnavailableError('beta is out of quota', 429, 60));
      const response = await via();
      expect(response.status).toBe(429);
      expect(response.headers.get('retry-after')).toBe('60');
      expect(tried(response)).toEqual(['alpha,beta', '2']);
    });
  }
});
