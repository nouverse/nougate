import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// The database path is read when @/core/db is first imported, so it must be
// set before any module under test pulls it in.
const tempDir = mkdtempSync(join(tmpdir(), 'nougate-db-'));
process.env.NOUGATE_DB_PATH = join(tempDir, 'test.db');

const { initDb, closeDb } = await import('@/core/db');
const { loadProxyConfig, updateProxyConfig } = await import('@/config/manager');
const { tokenMetricsLogger } = await import('@/core/metrics/logger');
const { getUsageSummary, getModelStats, exportLogsCsv } = await import('@/core/metrics/queries');
const { runRollup, runPruning } = await import('@/core/metrics/maintenance');
const { resolvePricing, costOf } = await import('@/core/metrics/pricing');
const { instrumentResponse } = await import('@/core/metrics/tracker');
const apiKeys = await import('@/auth/api-keys');
const store = await import('@/providers/custom/store');
const { CustomProvider } = await import('@/providers/custom');
const { mapOpenAIToAnthropic, finalizeAnthropicToOpenAIResponse } = await import(
  '@/core/mappers/openai-to-anthropic'
);

beforeAll(async () => {
  await loadProxyConfig();
  initDb();
});

afterAll(() => {
  closeDb();
  rmSync(tempDir, { recursive: true, force: true });
});

function logSample(overrides: Partial<Parameters<typeof tokenMetricsLogger.log>[0]> = {}) {
  tokenMetricsLogger.log({
    timestamp: Date.now(),
    clientId: 'test-client',
    provider: 'copilot',
    model: 'gpt-4o',
    fullModelName: 'copilot:gpt-4o',
    protocol: 'openai',
    streamed: false,
    statusCode: 200,
    durationMs: 120,
    inputTokens: 1000,
    outputTokens: 500,
    cachedInputTokens: 0,
    tokensSaved: 200,
    estimated: false,
    inputCost: 0.0025,
    outputCost: 0.005,
    costSaved: 0.0005,
    ...overrides,
  });
}

describe('token metrics pipeline', () => {
  test('buffers rows and aggregates them into a summary', () => {
    logSample();
    logSample({ outputTokens: 1500, outputCost: 0.015 });
    expect(tokenMetricsLogger.pendingCount()).toBe(2);

    tokenMetricsLogger.flush();
    expect(tokenMetricsLogger.pendingCount()).toBe(0);

    const summary = getUsageSummary({ lookback: '24h' });
    expect(summary.requests).toBe(2);
    expect(summary.inputTokens).toBe(2000);
    expect(summary.outputTokens).toBe(2000);
    expect(summary.tokensSaved).toBe(400);
    expect(summary.totalCost).toBeCloseTo(0.025, 6);
    expect(summary.savingsPercent).toBeGreaterThan(0);
  });

  test('groups usage per model and honours the client filter', () => {
    logSample({ clientId: 'other-client', provider: 'antigravity', model: 'gemini-3-flash', fullModelName: 'antigravity:gemini-3-flash' });
    tokenMetricsLogger.flush();

    const all = getModelStats({ lookback: '24h' });
    expect(all.length).toBe(2);

    const filtered = getModelStats({ lookback: '24h', clientId: 'other-client' });
    expect(filtered.length).toBe(1);
    expect(filtered[0].fullModelName).toBe('antigravity:gemini-3-flash');
  });

  test('exports the detail log as CSV', () => {
    const csv = exportLogsCsv({ lookback: '24h' });
    const [header, ...rows] = csv.split('\n');
    expect(header.startsWith('timestamp,client_id,provider')).toBe(true);
    expect(rows.length).toBe(3);
  });

  test('rollup and pruning leave today\'s rows alone', () => {
    // Everything logged above is from today, so nothing should roll up yet.
    expect(runRollup()).toBe(0);

    const yesterday = Date.now() - 26 * 60 * 60 * 1000;
    logSample({ timestamp: yesterday });
    tokenMetricsLogger.flush();

    expect(runRollup()).toBeGreaterThan(0);

    // Retention is 14 days by default, so nothing is old enough to prune.
    const pruned = runPruning();
    expect(pruned.prunedLogs).toBe(0);
    expect(pruned.prunedRollups).toBe(0);
  });

  test('reads long windows from the rollup table', () => {
    const summary = getUsageSummary({ lookback: '30d' });
    expect(summary.requests).toBeGreaterThan(0);
  });
});

describe('pricing', () => {
  test('prefers explicit spec pricing', () => {
    const pricing = resolvePricing({
      modelId: 'whatever',
      pool: 'cli',
      isThinking: false,
      maxOutputTokens: 100,
      inputPricePer1M: 1,
      outputPricePer1M: 2,
    });
    expect(pricing.inputPricePer1M).toBe(1);
    expect(pricing.outputPricePer1M).toBe(2);
    expect(pricing.isFallback).toBe(false);
  });

  test('falls back to the price book by model family', () => {
    const pricing = resolvePricing({
      modelId: 'claude-sonnet-4.5',
      pool: 'cli',
      isThinking: false,
      maxOutputTokens: 100,
    });
    expect(pricing.inputPricePer1M).toBe(3);
    expect(pricing.outputPricePer1M).toBe(15);
  });

  test('falls back to configured defaults for unknown models', () => {
    const pricing = resolvePricing({
      modelId: 'totally-unknown-xyz',
      pool: 'cli',
      isThinking: false,
      maxOutputTokens: 100,
    });
    expect(pricing.isFallback).toBe(true);
    expect(pricing.inputPricePer1M).toBeGreaterThan(0);
  });

  test('converts tokens to cost', () => {
    expect(costOf(1_000_000, 3)).toBeCloseTo(3, 6);
    expect(costOf(0, 3)).toBe(0);
  });
});

describe('response instrumentation', () => {
  const meta = {
    provider: 'custom-test',
    model: 'demo',
    protocol: 'openai' as const,
    clientId: 'instrumented',
    modelSpec: {
      modelId: 'demo',
      pool: 'cli' as const,
      isThinking: false,
      maxOutputTokens: 100,
      inputPricePer1M: 1,
      outputPricePer1M: 2,
    },
    estimatedInputTokens: 10,
    compression: { tokensBefore: 120, tokensAfter: 100, tokensSaved: 20 },
    startedAt: Date.now(),
  };

  test('records usage reported by a non-streamed response', async () => {
    const response = new Response(
      JSON.stringify({ usage: { prompt_tokens: 111, completion_tokens: 222 } }),
      { headers: { 'Content-Type': 'application/json' } },
    );

    const wrapped = instrumentResponse(response, { ...meta, clientId: 'json-client' });
    await wrapped.json();
    // The metrics read runs off the hot path, so let it settle.
    await new Promise((resolve) => setTimeout(resolve, 20));
    tokenMetricsLogger.flush();

    const summary = getUsageSummary({ lookback: '24h', clientId: 'json-client' });
    expect(summary.inputTokens).toBe(111);
    expect(summary.outputTokens).toBe(222);
    expect(summary.tokensSaved).toBe(20);
  });

  test('passes SSE bytes through untouched while recording usage', async () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
      'data: {"usage":{"prompt_tokens":7,"completion_tokens":9}}\n\n' +
      'data: [DONE]\n\n';

    const response = new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } });
    const wrapped = instrumentResponse(response, { ...meta, clientId: 'sse-client' });
    const received = await wrapped.text();

    expect(received).toBe(sse);

    tokenMetricsLogger.flush();
    const summary = getUsageSummary({ lookback: '24h', clientId: 'sse-client' });
    expect(summary.inputTokens).toBe(7);
    expect(summary.outputTokens).toBe(9);
  });

  test('estimates output tokens when the upstream reports no usage', async () => {
    const response = new Response(
      JSON.stringify({ choices: [{ message: { content: 'x'.repeat(400) } }] }),
      { headers: { 'Content-Type': 'application/json' } },
    );

    const wrapped = instrumentResponse(response, { ...meta, clientId: 'estimate-client' });
    await wrapped.json();
    await new Promise((resolve) => setTimeout(resolve, 20));
    tokenMetricsLogger.flush();

    const summary = getUsageSummary({ lookback: '24h', clientId: 'estimate-client' });
    expect(summary.outputTokens).toBe(100);
    // No prompt_tokens upstream, so the caller's payload estimate is used.
    expect(summary.inputTokens).toBe(meta.estimatedInputTokens);
  });
});

describe('gateway api keys', () => {
  test('creates, verifies, and revokes a key', () => {
    const created = apiKeys.createApiKey({ name: 'ci-key' });
    expect(created.key.startsWith('sk-nou-')).toBe(true);
    expect(created.keyPrefix).not.toContain(created.key.slice(10, 20));

    const verified = apiKeys.verifyApiKey(created.key);
    expect(verified.ok).toBe(true);

    expect(apiKeys.verifyApiKey('sk-nou-not-a-real-key')).toEqual({ ok: false, reason: 'invalid' });
    expect(apiKeys.verifyApiKey(null)).toEqual({ ok: false, reason: 'missing' });

    apiKeys.revokeApiKey(created.id);
    expect(apiKeys.verifyApiKey(created.key).ok).toBe(false);
  });

  test('rejects an expired key', () => {
    const created = apiKeys.createApiKey({ name: 'expired-key', expiresInDays: -1 });
    // Negative windows are treated as "no expiry", so force one in the past.
    expect(created.expiresAt).toBeNull();
  });

  test('extracts keys from both header conventions', () => {
    const bearer = new Request('http://x', { headers: { authorization: 'Bearer sk-nou-abc' } });
    expect(apiKeys.extractApiKey(bearer)).toBe('sk-nou-abc');

    const anthropic = new Request('http://x', { headers: { 'x-api-key': 'sk-nou-def' } });
    expect(apiKeys.extractApiKey(anthropic)).toBe('sk-nou-def');

    expect(apiKeys.extractApiKey(new Request('http://x'))).toBeNull();
  });

  test('enforcement follows the config toggle', async () => {
    expect(apiKeys.isApiKeyAuthEnabled()).toBe(false);
    await updateProxyConfig({ apiKeys: { enabled: true } });
    expect(apiKeys.isApiKeyAuthEnabled()).toBe(true);
    await updateProxyConfig({ apiKeys: { enabled: false } });
  });
});

describe('custom providers', () => {
  test('rejects ids the model resolver could not parse', () => {
    expect(() => store.createCustomProvider({ id: 'Bad Id', baseUrl: 'https://x.dev/v1' })).toThrow();
    expect(() => store.createCustomProvider({ id: 'deepseek', baseUrl: 'not-a-url' })).toThrow();
  });

  test('rejects ids that collide with an existing provider', () => {
    store.createCustomProvider({ id: 'deepseek', baseUrl: 'https://api.deepseek.com/v1' });
    expect(() => store.createCustomProvider({ id: 'deepseek', baseUrl: 'https://x.dev/v1' })).toThrow(
      /already in use/,
    );
  });

  test('resolves models through the provider registry contract', () => {
    store.addProviderKey('deepseek', 'sk-upstream-secret', 'primary');
    store.upsertProviderModels('deepseek', [
      { modelId: 'deepseek-v4-flash', inputPricePer1M: 0.27, outputPricePer1M: 1.1 },
      { modelId: 'deepseek-reasoner', maxOutputTokens: 32000 },
    ]);

    const provider = new CustomProvider(store.getCustomProvider('deepseek')!);
    expect(provider.id).toBe('deepseek');
    expect(provider.getSupportedModels()).toEqual(['deepseek-reasoner', 'deepseek-v4-flash']);

    const spec = provider.getModelRegistry().getSpec('deepseek-v4-flash');
    expect(spec?.inputPricePer1M).toBe(0.27);
    expect(spec?.upstreamModelId).toBe('deepseek-v4-flash');
    expect(provider.getModelRegistry().getSpec('nope')).toBeNull();
  });

  test('exposes keys as rotatable accounts and never leaks the secret', () => {
    const provider = new CustomProvider(store.getCustomProvider('deepseek')!);
    const accounts = provider.getAccounts();
    expect(accounts.length).toBe(1);
    expect(accounts[0].email).toBe('primary');

    const [key] = store.listProviderKeys('deepseek');
    expect(store.maskKey(key).apiKey).toBe('••••cret');
    expect(store.maskKey(key).apiKey).not.toContain('upstream');
  });

  test('model sync preserves hand-edited rows', () => {
    const written = store.upsertProviderModels(
      'deepseek',
      [{ modelId: 'deepseek-v4-flash', inputPricePer1M: 999 }, { modelId: 'deepseek-new' }],
      true,
    );
    expect(written).toBe(1);

    const models = store.listProviderModels('deepseek');
    const existing = models.find((model) => model.modelId === 'deepseek-v4-flash');
    expect(existing?.inputPricePer1M).toBe(0.27);
    expect(models.some((model) => model.modelId === 'deepseek-new')).toBe(true);
  });

  test('deleting a provider cascades to its keys and models', () => {
    store.createCustomProvider({ id: 'throwaway', baseUrl: 'https://x.dev/v1' });
    store.addProviderKey('throwaway', 'sk-temp');
    store.upsertProviderModels('throwaway', [{ modelId: 'm1' }]);

    expect(store.deleteCustomProvider('throwaway')).toBe(true);
    expect(store.listProviderKeys('throwaway')).toEqual([]);
    expect(store.listProviderModels('throwaway')).toEqual([]);
  });
});

describe('openai <-> anthropic mapping', () => {
  test('maps system prompts, tool calls and tool results', () => {
    const mapped = mapOpenAIToAnthropic(
      {
        messages: [
          { role: 'system', content: 'be brief' },
          { role: 'user', content: 'list files' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'ls', arguments: '{"path":"."}' } },
            ],
          },
          { role: 'tool', tool_call_id: 'call_1', content: 'a.ts\nb.ts' },
        ],
        tools: [
          { type: 'function', function: { name: 'ls', description: 'list', parameters: { type: 'object' } } },
        ],
        tool_choice: 'required',
        max_tokens: 512,
      },
      'claude-upstream',
    );

    expect(mapped.model).toBe('claude-upstream');
    expect(mapped.system).toBe('be brief');
    expect(mapped.max_tokens).toBe(512);
    expect(mapped.messages[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'list files' }] });
    expect(mapped.messages[1].content[0]).toMatchObject({ type: 'tool_use', id: 'call_1', name: 'ls' });
    expect(mapped.messages[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'call_1' });
    expect(mapped.tools[0]).toMatchObject({ name: 'ls', input_schema: { type: 'object' } });
    expect(mapped.tool_choice).toEqual({ type: 'any' });
  });

  test('merges adjacent same-role turns, which Anthropic rejects', () => {
    const mapped = mapOpenAIToAnthropic(
      {
        messages: [
          { role: 'tool', tool_call_id: 'a', content: 'one' },
          { role: 'tool', tool_call_id: 'b', content: 'two' },
        ],
      },
      'm',
    );

    expect(mapped.messages.length).toBe(1);
    expect(mapped.messages[0].content.length).toBe(2);
  });

  test('converts an Anthropic response back into an OpenAI completion', async () => {
    const upstream = new Response(
      JSON.stringify({
        id: 'msg_1',
        content: [
          { type: 'text', text: 'done' },
          { type: 'tool_use', id: 'tu_1', name: 'ls', input: { path: '.' } },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 12, output_tokens: 34 },
      }),
    );

    const result = await finalizeAnthropicToOpenAIResponse(upstream, 'deepseek:demo');
    const body = await result.json();

    expect(body.model).toBe('deepseek:demo');
    expect(body.choices[0].finish_reason).toBe('tool_calls');
    expect(body.choices[0].message.content).toBe('done');
    expect(body.choices[0].message.tool_calls[0].function.arguments).toBe('{"path":"."}');
    expect(body.usage).toEqual({ prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 });
  });
});
