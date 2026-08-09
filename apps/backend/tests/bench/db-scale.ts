const S = "/private/tmp/claude-501/-Users-gadingnst-Workspace-nouverse-nougate/25f9c9b2-2d45-404f-b955-ccd9b6e44cd1/scratchpad/bench";
process.env.NOUGATE_DB_PATH = `${S}/bench.db`;

const { initDb, getDb, t, closeDb, dialect } = await import("@/core/db");
const { getUsageSummary, getUsageSeries, getModelStats, getApiKeyStats } = await import("@/core/metrics/queries");
const { loadProxyConfig } = await import("@/config/manager");
await loadProxyConfig();
await initDb();

const MODELS = ["antigravity:gemini-3-flash","copilot:gpt-4o","openrouter:anthropic/claude-opus-4.5","openrouter:deepseek/deepseek-v4"];
const CLIENTS = ["claude-code","droid-ci","zed","unknown"];
const KEYS = ["key-laptop","key-ci",null];

const perDay = Number(process.argv[2] ?? 1000);
const rows = perDay * 14;                       // 14-day detail retention
const now = Date.now();

console.log(`\n  ${dialect} · ${perDay.toLocaleString()} req/hari → ${rows.toLocaleString()} baris (retensi 14 hari)`);

const t0 = performance.now();
const CHUNK = 2000;
for (let i = 0; i < rows; i += CHUNK) {
  const batch = [];
  for (let j = 0; j < Math.min(CHUNK, rows - i); j++) {
    const n = i + j;
    const m = MODELS[n % MODELS.length];
    batch.push({
      timestamp: now - Math.floor((n / rows) * 14 * 86400_000),
      clientId: CLIENTS[n % CLIENTS.length], apiKeyId: KEYS[n % KEYS.length],
      provider: m.split(":")[0], model: m.split(":")[1], fullModelName: m,
      protocol: "openai", streamed: n % 2, statusCode: 200, durationMs: 500 + (n % 4000),
      inputTokens: 1000 + (n % 40000), outputTokens: 200 + (n % 3000), cachedInputTokens: 0,
      tokensSaved: n % 5000, estimated: 0,
      inputCost: (n % 100) / 10000, outputCost: (n % 70) / 10000, costSaved: (n % 20) / 10000,
    });
  }
  await getDb().insert(t.tokenUsageLogs).values(batch);
}
const writeMs = performance.now() - t0;
console.log(`    tulis ${rows.toLocaleString()} baris : ${(writeMs/1000).toFixed(1)}s  (${Math.round(rows/(writeMs/1000)).toLocaleString()} baris/detik)`);

for (const [label, fn] of [
  ["summary   ", () => getUsageSummary({ lookback: "14d" })],
  ["chart     ", () => getUsageSeries({ lookback: "14d" })],
  ["per-model ", () => getModelStats({ lookback: "14d" })],
  ["per-key   ", () => getApiKeyStats({ lookback: "14d" })],
] as const) {
  const s = performance.now();
  await fn(); await fn(); await fn();
  console.log(`    ${label}: ${((performance.now()-s)/3).toFixed(1)} ms`);
}
await closeDb();
