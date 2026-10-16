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
import { AnthropicProtocolHandler } from '@/protocols/anthropic/handler';
import { OpenAIProtocolHandler } from '@/protocols/openai/handler';
import { withCorsHeaders } from '@/router/middleware';

const NO_JITTER: JitterConfig = { jitterEnabled: false, jitterMinMs: 0, jitterMaxMs: 0 };

function provider(id: string, answer: () => Response): IProvider {
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
afterEach(() => unregisterProvider('alpha'));

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
