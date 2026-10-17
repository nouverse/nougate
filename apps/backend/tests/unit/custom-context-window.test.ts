/**
 * A custom provider's context windows (G2): taken from its upstream's `/models` when a sync finds them, kept when the
 * operator wrote one by hand, and on the spec only when there is one — against a real database, both halves of the
 * schema and the column a database from before this gets added.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// The database path is read when @/core/db is first imported, so it must be set before anything pulls it in.
const tempDir = mkdtempSync(join(tmpdir(), "nougate-ctx-"));
process.env.NOUGATE_DB_PATH = join(tempDir, "test.db");

const { initDb, closeDb } = await import("@/core/db");
const { loadProxyConfig } = await import("@/config/manager");
const store = await import("@/providers/custom/store");
const { syncProviderModels } = await import("@/providers/custom/model-sync");
const { CustomProvider } = await import("@/providers/custom");

const realFetch = globalThis.fetch;

beforeAll(async () => {
  await loadProxyConfig();
  await initDb();
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await closeDb();
  rmSync(tempDir, { recursive: true, force: true });
});

/** The upstream's `/models`, as the sync reads it. */
function upstream(data: unknown[]): void {
  globalThis.fetch = (async () => Response.json({ data })) as unknown as typeof fetch;
}

describe("a custom provider's context windows", () => {
  test("a sync takes what the upstream states, fills a model that had none, and keeps one set by hand", async () => {
    await store.createCustomProvider({ id: "router", baseUrl: "https://router.test/v1" });
    await store.addProviderKey("router", "sk-upstream", "primary");
    await store.upsertProviderModels("router", [
      { modelId: "hand-set", contextWindow: 64_000 },
      { modelId: "had-none" },
    ]);

    upstream([
      { id: "new-model", context_length: 262_144 },
      { id: "hand-set", context_length: 1_000_000 },
      { id: "had-none", context_length: 131_072 },
      { id: "silent-model" },
    ]);
    const result = await syncProviderModels((await store.getCustomProvider("router"))!);
    expect(result.discovered.sort()).toEqual(["had-none", "hand-set", "new-model", "silent-model"]);

    const windows = Object.fromEntries((await store.listProviderModels("router")).map((model) => [model.modelId, model.contextWindow]));
    expect(windows).toEqual({ "new-model": 262_144, "hand-set": 64_000, "had-none": 131_072, "silent-model": null });
  });

  test("the spec states a window only when there is one, so /models leaves the rest unknown", async () => {
    await store.createCustomProvider({ id: "spec-check", baseUrl: "https://spec.test/v1" });
    await store.upsertProviderModels("spec-check", [{ modelId: "with", contextWindow: 200_000 }, { modelId: "without" }]);
    const provider = new CustomProvider((await store.getCustomProvider("spec-check"))!);
    await provider.init();

    expect(provider.getModelRegistry().getSpec("with")?.contextWindow).toBe(200_000);
    expect(provider.getModelRegistry().getSpec("without")).not.toHaveProperty("contextWindow");
  });

  test("a window that is not one is stored as unknown, never as a number", async () => {
    await store.createCustomProvider({ id: "odd", baseUrl: "https://odd.test/v1" });
    await store.upsertProviderModels("odd", [{ modelId: "tiny", contextWindow: 100 }, { modelId: "fraction", contextWindow: 4096.5 }]);
    const windows = Object.fromEntries((await store.listProviderModels("odd")).map((model) => [model.modelId, model.contextWindow]));
    expect(windows).toEqual({ tiny: null, fraction: null });
  });
});

describe("a database from before the column", () => {
  test("takes it at start, and keeps every model it had", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nougate-old-db-"));
    try {
      const path = join(dir, "old.db");
      const { Database } = await import("bun:sqlite");
      const old = new Database(path);
      old.exec(`CREATE TABLE custom_providers (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, base_url TEXT NOT NULL, api_style TEXT NOT NULL DEFAULT 'openai', extra_headers TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
      old.exec(`CREATE TABLE custom_provider_models (provider_id TEXT NOT NULL, model_id TEXT NOT NULL, display_name TEXT, upstream_model_id TEXT, pool TEXT NOT NULL DEFAULT 'cli', is_thinking INTEGER NOT NULL DEFAULT 0, thinking_mode TEXT, thinking_budget INTEGER, max_output_tokens INTEGER NOT NULL DEFAULT 8192, timeout_ms INTEGER NOT NULL DEFAULT 60000, input_price_per_1m REAL, output_price_per_1m REAL, enabled INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (provider_id, model_id))`);
      old.exec(`INSERT INTO custom_providers (id, display_name, base_url, created_at, updated_at) VALUES ('kept', 'kept', 'https://kept.test/v1', 1, 1)`);
      old.exec(`INSERT INTO custom_provider_models (provider_id, model_id) VALUES ('kept', 'm')`);
      old.close();

      // A process of its own: the database path is read once, when the module is first imported.
      const child = Bun.spawnSync(["bun", "-e", `const { initDb, closeDb } = await import("@/core/db"); await initDb(); await closeDb();`], {
        cwd: import.meta.dir + "/../..",
        env: { ...process.env, NOUGATE_DB_PATH: path },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(child.exitCode).toBe(0);

      const after = new Database(path, { readonly: true });
      const columns = (after.query("PRAGMA table_info(custom_provider_models)").all() as { name: string }[]).map((row) => row.name);
      const rows = after.query("SELECT model_id, context_window FROM custom_provider_models").all();
      after.close();
      expect(columns).toContain("context_window");
      expect(rows).toEqual([{ model_id: "m", context_window: null }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
