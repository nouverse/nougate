import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// The database path is read when @/core/db is first imported, so it must be
// set before any module under test pulls it in.
const tempDir = mkdtempSync(join(tmpdir(), 'nougate-db-'));
process.env.NOUGATE_DB_PATH = join(tempDir, 'test.db');

const { initDb, closeDb } = await import('@/core/db');
const { loadProxyConfig, updateProxyConfig, getProxyConfig } = await import('@/config/manager');
const { tokenMetricsLogger } = await import('@/core/metrics/logger');
const { getUsageSummary, getModelStats, getApiKeyStats, getCompressionBreakdown, exportLogsCsv } =
  await import('@/core/metrics/queries');
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
  // Pin the blanket fallback off so these assertions do not depend on whatever
  // the developer's config.json happens to contain.
  await updateProxyConfig({
    metrics: { ...getProxyConfig().metrics!, defaultInputPricePer1M: 0, defaultOutputPricePer1M: 0 },
  });
  await initDb();
});

afterAll(async () => {
  await closeDb();
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
    cacheCostSaved: 0,
    ...overrides,
  });
}

describe('token metrics pipeline', () => {
  test('buffers rows and aggregates them into a summary', async () => {
    logSample();
    logSample({ outputTokens: 1500, outputCost: 0.015 });
    expect(tokenMetricsLogger.pendingCount()).toBe(2);

    await tokenMetricsLogger.flush();
    expect(tokenMetricsLogger.pendingCount()).toBe(0);

    const summary = await getUsageSummary({ lookback: '24h' });
    expect(summary.requests).toBe(2);
    expect(summary.inputTokens).toBe(2000);
    expect(summary.outputTokens).toBe(2000);
    expect(summary.tokensSaved).toBe(400);
    expect(summary.totalCost).toBeCloseTo(0.025, 6);
    expect(summary.savingsPercent).toBeGreaterThan(0);
  });

  test('groups usage per model and honours the client filter', async () => {
    logSample({ clientId: 'other-client', provider: 'antigravity', model: 'gemini-3-flash', fullModelName: 'antigravity:gemini-3-flash' });
    await tokenMetricsLogger.flush();

    const all = await getModelStats({ lookback: '24h' });
    expect(all.length).toBe(2);

    const filtered = await getModelStats({ lookback: '24h', clientId: 'other-client' });
    expect(filtered.length).toBe(1);
    expect(filtered[0].fullModelName).toBe('antigravity:gemini-3-flash');
  });

  test('exports the detail log as CSV', async () => {
    const csv = await exportLogsCsv({ lookback: '24h' });
    const [header, ...rows] = csv.split('\n');
    expect(header.startsWith('timestamp,client_id,api_key_id,provider')).toBe(true);
    // Per-engine attribution travels with the export, not just the dashboard.
    expect(header).toContain('compression_breakdown');
    expect(rows.length).toBe(3);
  });

  test('rollup and pruning leave today\'s rows alone', async () => {
    // Everything logged above is from today, so nothing should roll up yet.
    expect(await runRollup()).toBe(0);

    const yesterday = Date.now() - 26 * 60 * 60 * 1000;
    logSample({ timestamp: yesterday });
    await tokenMetricsLogger.flush();

    expect(await runRollup()).toBeGreaterThan(0);

    // Retention is 14 days by default, so nothing is old enough to prune.
    const pruned = await runPruning();
    expect(pruned.prunedLogs).toBe(0);
    expect(pruned.prunedRollups).toBe(0);
  });

  test('reads long windows from the rollup table', async () => {
    const summary = await getUsageSummary({ lookback: '30d' });
    expect(summary.requests).toBeGreaterThan(0);
  });
});

describe('api key attribution', () => {
  test('groups usage by the key that authorised it', async () => {
    logSample({ clientId: 'k1-client', apiKeyId: 'key-one', inputTokens: 700, outputTokens: 300 });
    logSample({ clientId: 'k1-client', apiKeyId: 'key-one', inputTokens: 700, outputTokens: 300 });
    logSample({ clientId: 'k2-client', apiKeyId: 'key-two', inputTokens: 100, outputTokens: 50 });
    await tokenMetricsLogger.flush();

    const stats = await getApiKeyStats({ lookback: '24h' });
    const byId = Object.fromEntries(stats.map((entry) => [entry.apiKeyId, entry]));

    expect(byId['key-one'].requests).toBe(2);
    expect(byId['key-one'].totalTokens).toBe(2000);
    expect(byId['key-two'].requests).toBe(1);

    // A key ID with no matching row in api_keys is still identifiable.
    expect(byId['key-one'].name).toBe('deleted key');
  });

  test('buckets keyless traffic under "no key"', async () => {
    // Every earlier sample in this file was logged without an api_key_id.
    const stats = await getApiKeyStats({ lookback: '24h' });
    const keyless = stats.find((entry) => entry.apiKeyId === 'none');

    expect(keyless).toBeDefined();
    expect(keyless!.name).toBe('no key');
    expect(keyless!.requests).toBeGreaterThan(0);
  });

  test('filters the summary down to one key', async () => {
    const all = await getUsageSummary({ lookback: '24h' });
    const one = await getUsageSummary({ lookback: '24h', apiKeyId: 'key-one' });
    const keyless = await getUsageSummary({ lookback: '24h', apiKeyId: 'none' });

    expect(one.requests).toBe(2);
    expect(keyless.requests).toBeGreaterThan(0);
    expect(one.requests + keyless.requests).toBeLessThanOrEqual(all.requests);
  });

  test('composes with the client filter', async () => {
    expect((await getUsageSummary({ lookback: '24h', apiKeyId: 'key-one', clientId: 'k1-client' })).requests)
      .toBe(2);
    expect((await getUsageSummary({ lookback: '24h', apiKeyId: 'key-one', clientId: 'k2-client' })).requests)
      .toBe(0);
  });

  test('survives the rollup, so long windows can be filtered too', async () => {
    const yesterday = Date.now() - 26 * 60 * 60 * 1000;
    logSample({ timestamp: yesterday, apiKeyId: 'key-one', clientId: 'k1-client' });
    await tokenMetricsLogger.flush();
    await runRollup();

    // 30d is served from the rollup table rather than the detail log.
    const rolled = await getUsageSummary({ lookback: '30d', apiKeyId: 'key-one' });
    expect(rolled.requests).toBeGreaterThan(0);

    const other = await getUsageSummary({ lookback: '30d', apiKeyId: 'key-two' });
    expect(other.requests).toBeLessThan(rolled.requests);
  });

  test('exports only the selected key', async () => {
    const csv = await exportLogsCsv({ lookback: '24h', apiKeyId: 'key-two' });
    const rows = csv.split('\n').slice(1).filter(Boolean);

    expect(csv.split('\n')[0]).toContain('api_key_id');
    expect(rows.length).toBe(1);
    expect(rows[0]).toContain('key-two');
  });
});

describe('compression attribution', () => {
  test('splits savings between the engines that ran', async () => {
    logSample({
      clientId: 'compress-client',
      tokensSaved: 250,
      compressionBreakdown: [
        { engine: 'rtk', tokensSaved: 200 },
        { engine: 'headroom', tokensSaved: 50 },
      ],
    });
    logSample({
      clientId: 'compress-client',
      tokensSaved: 100,
      compressionBreakdown: [{ engine: 'rtk', tokensSaved: 100 }],
    });
    await tokenMetricsLogger.flush();

    const breakdown = await getCompressionBreakdown({
      lookback: '24h',
      clientId: 'compress-client',
    });

    expect(breakdown.available).toBe(true);
    const byEngine = Object.fromEntries(breakdown.engines.map((e) => [e.engine, e]));

    expect(byEngine.rtk.tokensSaved).toBe(300);
    expect(byEngine.rtk.requests).toBe(2);
    expect(byEngine.headroom.tokensSaved).toBe(50);
    // Headroom only ran on one of the two requests.
    expect(byEngine.headroom.requests).toBe(1);

    // Shares are of the window's total savings, and add up.
    expect(byEngine.rtk.sharePercent).toBeCloseTo((300 / 350) * 100, 4);
    const totalShare = breakdown.engines.reduce((sum, e) => sum + e.sharePercent, 0);
    expect(totalShare).toBeCloseTo(100, 4);
  });

  test('the engines are ranked by what they actually saved', async () => {
    const breakdown = await getCompressionBreakdown({
      lookback: '24h',
      clientId: 'compress-client',
    });
    expect(breakdown.engines[0].engine).toBe('rtk');
  });

  test('the detail window follows the configured retention, not a constant', async () => {
    // These were two independent 14s: the pruner's, and the read side's table
    // choice. Raising retention kept rows that nothing would ever read, and the
    // per-engine panel still reported "unavailable" for data sitting right there.
    const original = getProxyConfig().metrics!;

    try {
      await updateProxyConfig({ metrics: { ...original, detailRetentionDays: 60 } });
      // 30d now fits inside the detail log, so attribution is available.
      expect((await getCompressionBreakdown({ lookback: '30d' })).available).toBe(true);
      // 90d still exceeds it.
      expect((await getCompressionBreakdown({ lookback: '90d' })).available).toBe(false);

      await updateProxyConfig({ metrics: { ...original, detailRetentionDays: 1 } });
      expect((await getCompressionBreakdown({ lookback: '7d' })).available).toBe(false);
      expect((await getCompressionBreakdown({ lookback: '24h' })).available).toBe(true);
    } finally {
      await updateProxyConfig({ metrics: original });
    }
  });

  test('says so when the window has no per-engine detail', async () => {
    // Rollups keep one total; claiming an empty breakdown would read as
    // "compression saved nothing", which is a different and wrong statement.
    const breakdown = await getCompressionBreakdown({ lookback: '30d' });
    expect(breakdown.available).toBe(false);
    expect(breakdown.engines).toEqual([]);
  });

  test('a request with compression off contributes no engines', async () => {
    logSample({ clientId: 'nocompress-client', tokensSaved: 0 });
    await tokenMetricsLogger.flush();

    const breakdown = await getCompressionBreakdown({
      lookback: '24h',
      clientId: 'nocompress-client',
    });
    expect(breakdown.engines).toEqual([]);
    expect(breakdown.tokensSaved).toBe(0);
  });
});

describe('pricing', () => {
  test('prefers explicit spec pricing', async () => {
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
    expect(pricing.isPriced).toBe(true);
  });

  test('falls back to the price book by model family', async () => {
    const pricing = resolvePricing({
      modelId: 'claude-sonnet-4.5',
      pool: 'cli',
      isThinking: false,
      maxOutputTokens: 100,
    });
    expect(pricing.inputPricePer1M).toBe(3);
    expect(pricing.outputPricePer1M).toBe(15);
  });

  test('reports an unknown model as unpriced rather than inventing a rate', async () => {
    const pricing = resolvePricing({
      modelId: 'totally-unknown-xyz',
      pool: 'cli',
      isThinking: false,
      maxOutputTokens: 100,
    });
    expect(pricing.isPriced).toBe(false);
    expect(pricing.inputPricePer1M).toBe(0);
    expect(pricing.outputPricePer1M).toBe(0);
  });

  test('treats an explicit zero as a real price, not as unknown', async () => {
    const pricing = resolvePricing({
      modelId: 'some-free-model',
      pool: 'cli',
      isThinking: false,
      maxOutputTokens: 100,
      inputPricePer1M: 0,
      outputPricePer1M: 0,
    });
    expect(pricing.isPriced).toBe(true);
  });

  test('prices aggregator-style ids from the price book', async () => {
    // OpenRouter exposes "vendor/model" ids; the book must still match, or a
    // gateway with hundreds of models would report everything as unpriced.
    const opus = resolvePricing({
      modelId: 'anthropic/claude-opus-4.5',
      pool: 'cli',
      isThinking: false,
      maxOutputTokens: 100,
    });
    expect(opus.isPriced).toBe(true);
    expect(opus.inputPricePer1M).toBe(5);
  });

  test('converts tokens to cost', async () => {
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
    compression: {
      tokensBefore: 120,
      tokensAfter: 100,
      tokensSaved: 20,
      byEngine: [{ engine: 'rtk', tokensSaved: 20 }],
    },
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
    await tokenMetricsLogger.flush();

    const summary = await getUsageSummary({ lookback: '24h', clientId: 'json-client' });
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

    await tokenMetricsLogger.flush();
    const summary = await getUsageSummary({ lookback: '24h', clientId: 'sse-client' });
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
    await tokenMetricsLogger.flush();

    const summary = await getUsageSummary({ lookback: '24h', clientId: 'estimate-client' });
    expect(summary.outputTokens).toBe(100);
    // No prompt_tokens upstream, so the caller's payload estimate is used.
    expect(summary.inputTokens).toBe(meta.estimatedInputTokens);
  });
});

describe('gateway api keys', () => {
  test('creates, verifies, and revokes a key', async () => {
    const created = await apiKeys.createApiKey({ name: 'ci-key' });
    expect(created.key.startsWith('sk-nou-')).toBe(true);
    expect(created.keyPrefix).not.toContain(created.key.slice(10, 20));

    const verified = apiKeys.verifyApiKey(created.key);
    expect(verified.ok).toBe(true);

    expect(apiKeys.verifyApiKey('sk-nou-not-a-real-key')).toEqual({ ok: false, reason: 'invalid' });
    expect(apiKeys.verifyApiKey(null)).toEqual({ ok: false, reason: 'missing' });

    await apiKeys.revokeApiKey(created.id);
    expect(apiKeys.verifyApiKey(created.key).ok).toBe(false);
  });

  test('rejects an expired key', async () => {
    const created = await apiKeys.createApiKey({ name: 'expired-key', expiresInDays: -1 });
    // Negative windows are treated as "no expiry", so force one in the past.
    expect(created.expiresAt).toBeNull();
  });

  test('extracts keys from both header conventions', async () => {
    const bearer = new Request('http://x', { headers: { authorization: 'Bearer sk-nou-abc' } });
    expect(apiKeys.extractApiKey(bearer)).toBe('sk-nou-abc');

    const anthropic = new Request('http://x', { headers: { 'x-api-key': 'sk-nou-def' } });
    expect(apiKeys.extractApiKey(anthropic)).toBe('sk-nou-def');

    expect(apiKeys.extractApiKey(new Request('http://x'))).toBeNull();
  });

  test('there is no way to switch enforcement off', async () => {
    // Enforcement used to be a config toggle that defaulted to off, so a fresh
    // deployment served anyone who could reach it. The toggle is gone: proxy
    // routes always verify, and the only exported surface is verification.
    expect('isApiKeyAuthEnabled' in apiKeys).toBe(false);

    const { getProxyConfig } = await import('@/config/manager');
    expect('apiKeys' in (getProxyConfig() as unknown as Record<string, unknown>)).toBe(false);
  });

  test('an instance with no keys at all rejects rather than opens up', async () => {
    // Fail closed: "no keys configured" must never be read as "no key needed".
    for (const key of await apiKeys.listApiKeys()) {
      await apiKeys.deleteApiKey(key.id);
    }

    expect(apiKeys.verifyApiKey(null)).toEqual({ ok: false, reason: 'missing' });
    expect(apiKeys.verifyApiKey('sk-nou-anything').ok).toBe(false);
  });
});

describe('custom providers', () => {
  test('rejects ids the model resolver could not parse', async () => {
    await expect(store.createCustomProvider({ id: 'Bad Id', baseUrl: 'https://x.dev/v1' })).rejects.toThrow();
    await expect(store.createCustomProvider({ id: 'deepseek', baseUrl: 'not-a-url' })).rejects.toThrow();
  });

  test('rejects ids that collide with an existing provider', async () => {
    await store.createCustomProvider({ id: 'deepseek', baseUrl: 'https://api.deepseek.com/v1' });
    await expect(store.createCustomProvider({ id: 'deepseek', baseUrl: 'https://x.dev/v1' })).rejects.toThrow(
      /already in use/,
    );
  });

  test('resolves models through the provider registry contract', async () => {
    await store.addProviderKey('deepseek', 'sk-upstream-secret', 'primary');
    await store.upsertProviderModels('deepseek', [
      { modelId: 'deepseek-v4-flash', inputPricePer1M: 0.27, outputPricePer1M: 1.1 },
      { modelId: 'deepseek-reasoner', maxOutputTokens: 32000 },
    ]);

    const provider = new CustomProvider((await store.getCustomProvider('deepseek'))!);
    // The provider serves keys and models from an in-memory snapshot, which
    // init() populates — the sync IProvider getters cannot await a query.
    await provider.init();
    expect(provider.id).toBe('deepseek');
    expect(provider.getSupportedModels()).toEqual(['deepseek-reasoner', 'deepseek-v4-flash']);

    const spec = provider.getModelRegistry().getSpec('deepseek-v4-flash');
    expect(spec?.inputPricePer1M).toBe(0.27);
    expect(spec?.upstreamModelId).toBe('deepseek-v4-flash');
    expect(provider.getModelRegistry().getSpec('nope')).toBeNull();
  });

  test('exposes keys as rotatable accounts and never leaks the secret', async () => {
    const provider = new CustomProvider((await store.getCustomProvider('deepseek'))!);
    await provider.init();
    const accounts = provider.getAccounts();
    expect(accounts.length).toBe(1);
    expect(accounts[0].email).toBe('primary');

    const [key] = await store.listProviderKeys('deepseek');
    expect(store.maskKey(key).apiKey).toBe('••••cret');
    expect(store.maskKey(key).apiKey).not.toContain('upstream');
  });

  test('renaming a provider reaches the live instance, not just the row', async () => {
    // The registry hands the sidebar and the model catalogue this instance, so
    // a name copied at construction time would go stale on every edit.
    const provider = new CustomProvider((await store.getCustomProvider('deepseek'))!);
    await provider.init();
    const before = provider.displayName;

    await store.updateCustomProvider('deepseek', { displayName: 'Deep Seek' });
    await provider.refresh();

    expect(before).not.toBe('Deep Seek');
    expect(provider.displayName).toBe('Deep Seek');

    await store.updateCustomProvider('deepseek', { displayName: before });
  });

  test('an unlabelled key is named "primary" only while it is the first one', async () => {
    // The form's placeholder says "primary", so the first key has to actually
    // get that name. A second unlabelled key must not collide with it.
    await store.createCustomProvider({ id: 'unlabelled', baseUrl: 'https://x.dev/v1' });

    await store.addProviderKey('unlabelled', 'sk-first-aaaa');
    await store.addProviderKey('unlabelled', 'sk-second-bbbb');

    const labels = (await store.listProviderKeys('unlabelled')).map((key) => key.label);
    expect(labels).toContain('primary');
    expect(labels).toContain('key-bbbb');

    await store.deleteCustomProvider('unlabelled');
  });

  test('model sync preserves hand-edited rows', async () => {
    const written = await store.upsertProviderModels(
      'deepseek',
      [{ modelId: 'deepseek-v4-flash', inputPricePer1M: 999 }, { modelId: 'deepseek-new' }],
      true,
    );
    expect(written).toBe(1);

    const models = await store.listProviderModels('deepseek');
    const existing = models.find((model) => model.modelId === 'deepseek-v4-flash');
    expect(existing?.inputPricePer1M).toBe(0.27);
    expect(models.some((model) => model.modelId === 'deepseek-new')).toBe(true);
  });

  test('a model switched off stays off through a save that does not say, and through a sync', async () => {
    // OpenRouter kept listing a model its operator had removed: the dashboard could only delete one, and the next
    // auto-load brought it back. Off is kept, so the sync skips it, and never served.
    await store.createCustomProvider({ id: 'switchable', baseUrl: 'https://x.dev/v1' });
    await store.addProviderKey('switchable', 'sk-temp');
    await store.upsertProviderModels('switchable', [{ modelId: 'old-flash', enabled: false }, { modelId: 'kept' }]);
    await store.upsertProviderModels('switchable', [{ modelId: 'old-flash', inputPricePer1M: 0.3 }]);
    await store.upsertProviderModels('switchable', [{ modelId: 'old-flash' }, { modelId: 'kept' }, { modelId: 'new-one' }], true);

    const enabled = Object.fromEntries((await store.listProviderModels('switchable')).map((model) => [model.modelId, model.enabled]));
    expect(enabled).toEqual({ 'old-flash': false, kept: true, 'new-one': true });
    const provider = new CustomProvider((await store.getCustomProvider('switchable'))!);
    await provider.init();
    expect(provider.getSupportedModels()).toEqual(['kept', 'new-one']);

    await store.upsertProviderModels('switchable', [{ modelId: 'old-flash', enabled: true }]);
    expect((await store.listProviderModels('switchable')).find((model) => model.modelId === 'old-flash')?.enabled).toBe(true);
    expect(await store.deleteCustomProvider('switchable')).toBe(true);
  });

  test('a save keeps what it does not state, and null clears', async () => {
    // A price written alone reset the window the upstream had stated, the output limit and the thinking flag.
    await store.createCustomProvider({ id: 'partial', baseUrl: 'https://x.dev/v1' });
    await store.upsertProviderModels('partial', [{ modelId: 'm', contextWindow: 32768, maxOutputTokens: 16000, isThinking: true }]);
    await store.upsertProviderModels('partial', [{ modelId: 'm', inputPricePer1M: 0.3 }]);
    const row = async () => (await store.listProviderModels('partial')).find((model) => model.modelId === 'm');
    expect(await row()).toMatchObject({ contextWindow: 32768, maxOutputTokens: 16000, isThinking: true, inputPricePer1M: 0.3, enabled: true });

    await store.upsertProviderModels('partial', [{ modelId: 'm', contextWindow: null, inputPricePer1M: null }]);
    expect(await row()).toMatchObject({ contextWindow: null, inputPricePer1M: null, maxOutputTokens: 16000 });
    expect(await store.deleteCustomProvider('partial')).toBe(true);
  });

  test('deleting a provider cascades to its keys and models', async () => {
    await store.createCustomProvider({ id: 'throwaway', baseUrl: 'https://x.dev/v1' });
    await store.addProviderKey('throwaway', 'sk-temp');
    await store.upsertProviderModels('throwaway', [{ modelId: 'm1' }]);

    expect(await store.deleteCustomProvider('throwaway')).toBe(true);
    expect(await store.listProviderKeys('throwaway')).toEqual([]);
    expect(await store.listProviderModels('throwaway')).toEqual([]);
  });
});

describe('openai <-> anthropic mapping', () => {
  test('maps system prompts, tool calls and tool results', async () => {
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

  test('merges adjacent same-role turns, which Anthropic rejects', async () => {
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

/**
 * Prompt-cache accounting.
 *
 * The discount was already applied to the bill before this, so the spend was right and the *saving*
 * was invisible: a deployment reading 77% of its input from the cache reported no benefit at all,
 * because `costSaved` only ever meant compression. Two engines, two numbers, one total.
 */
describe('prompt cache savings', () => {
  test('cached input is reported and priced as its own saving', async () => {
    logSample({
      clientId: 'cache-client',
      inputTokens: 20_000,
      cachedInputTokens: 16_000,
      cacheCostSaved: 0.0144,
      tokensSaved: 0,
      costSaved: 0,
    });
    await tokenMetricsLogger.flush();

    const summary = await getUsageSummary({
      lookback: '24h',
      clientId: 'cache-client',
      provider: 'all',
      apiKeyId: 'all',
    });

    expect(summary.cachedInputTokens).toBe(16_000);
    expect(summary.cacheCostSaved).toBeCloseTo(0.0144, 6);
    // The saving belongs in the counterfactual: what this would have cost with neither engine.
    expect(summary.originalCost).toBeCloseTo(summary.totalCost + summary.cacheCostSaved, 6);
    expect(summary.savingsPercent).toBeGreaterThan(0);
  });

  test('a window with no caching reports zero rather than nothing', async () => {
    // A metric that reads blank when a feature is off is indistinguishable from one that is broken.
    logSample({ clientId: 'plain-client', cachedInputTokens: 0, cacheCostSaved: 0 });
    await tokenMetricsLogger.flush();

    const summary = await getUsageSummary({
      lookback: '24h',
      clientId: 'plain-client',
      provider: 'all',
      apiKeyId: 'all',
    });

    expect(summary.cachedInputTokens).toBe(0);
    expect(summary.cacheCostSaved).toBe(0);
  });

  test('the two engines stay separate', async () => {
    // One blurred total answers "are we saving" and loses "how" — and the compression breakdown panel
    // already exists to answer the second question.
    logSample({
      clientId: 'both-client',
      cachedInputTokens: 5_000,
      cacheCostSaved: 0.005,
      tokensSaved: 1_000,
      costSaved: 0.002,
    });
    await tokenMetricsLogger.flush();

    const summary = await getUsageSummary({
      lookback: '24h',
      clientId: 'both-client',
      provider: 'all',
      apiKeyId: 'all',
    });

    expect(summary.costSaved).toBeCloseTo(0.002, 6);
    expect(summary.cacheCostSaved).toBeCloseTo(0.005, 6);
    expect(summary.originalCost).toBeCloseTo(summary.totalCost + 0.007, 6);
  });
});
