import { describe, expect, test, beforeAll, afterEach } from "bun:test";
import { antigravityModelRegistry } from "@/providers/antigravity/config/model-specs";
import { getProxyConfig, loadProxyConfig } from "@/config/manager";

/**
 * The registry's *contents* churn — models get added and retired as accounts gain
 * and lose access upstream. Pinning one model ID here made a routine registry
 * edit fail the build, so these tests assert the registry's contract instead:
 * it is non-empty, and getSpec and listModelIds agree about what is in it.
 */
describe("Antigravity Model Registry", () => {
  beforeAll(async () => {
    // Self-sufficient setup: getSpec reads bypassModelValidation from the config
    // singleton, and this file must not depend on another test file loading it.
    await loadProxyConfig();
  });

  afterEach(() => {
    // The flag is a process-wide singleton — leaving it flipped leaks into every
    // test file that runs after this one.
    getProxyConfig().bypassModelValidation = false;
  });

  test("the registry lists at least one model", () => {
    const modelIds = antigravityModelRegistry.listModelIds();

    expect(Array.isArray(modelIds)).toBe(true);
    // A provider with no models serves nobody, so an empty registry is a bug
    // rather than a configuration choice.
    expect(modelIds.length).toBeGreaterThan(0);
  });

  test("getSpec resolves every model that listModelIds advertises", () => {
    const modelIds = antigravityModelRegistry.listModelIds();

    for (const modelId of modelIds) {
      const modelSpec = antigravityModelRegistry.getSpec(modelId);
      expect(modelSpec).not.toBeNull();
      expect(modelSpec?.modelId).toBe(modelId);
      expect(modelSpec?.pool).toBe("sandbox");
      expect(modelSpec?.maxOutputTokens).toBeGreaterThan(0);
    }
  });

  test("getSpec is case- and whitespace-insensitive", () => {
    const [modelId] = antigravityModelRegistry.listModelIds();

    expect(antigravityModelRegistry.getSpec(`  ${modelId.toUpperCase()}  `)?.modelId).toBe(modelId);
  });

  test("getSpec returns null for an unknown model when bypassModelValidation is false", () => {
    getProxyConfig().bypassModelValidation = false;
    expect(antigravityModelRegistry.getSpec("nonexistent-model")).toBeNull();
  });

  test("getSpec returns dynamic fallback spec for an unknown model when bypassModelValidation is true", () => {
    getProxyConfig().bypassModelValidation = true;
    const spec = antigravityModelRegistry.getSpec("nonexistent-model");
    expect(spec).not.toBeNull();
    expect(spec?.modelId).toBe("nonexistent-model");
  });
});
