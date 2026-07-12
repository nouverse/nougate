import { describe, expect, test } from "bun:test";
import { antigravityModelRegistry } from "@/providers/antigravity/config/model-specs";
import { getProxyConfig } from "@/config/manager";

describe("Antigravity Model Registry", () => {
  test("getSpec returns a model spec for a known model", () => {
    const modelSpec = antigravityModelRegistry.getSpec("gemini-3.5-flash-low");

    expect(modelSpec).not.toBeNull();
    expect(modelSpec?.modelId).toBe("gemini-3.5-flash-low");
    expect(modelSpec?.pool).toBe("sandbox");
  });

  test("getSpec returns null for an unknown model when bypassModelValidation is false", () => {
    const config = getProxyConfig();
    config.bypassModelValidation = false;
    expect(antigravityModelRegistry.getSpec("nonexistent-model")).toBeNull();
  });

  test("getSpec returns dynamic fallback spec for an unknown model when bypassModelValidation is true", () => {
    const config = getProxyConfig();
    config.bypassModelValidation = true;
    const spec = antigravityModelRegistry.getSpec("nonexistent-model");
    expect(spec).not.toBeNull();
    expect(spec?.modelId).toBe("nonexistent-model");
  });

  test("listModelIds returns provider-local model IDs", () => {
    const modelIds = antigravityModelRegistry.listModelIds();

    expect(Array.isArray(modelIds)).toBe(true);
    expect(modelIds).toContain("gemini-3.5-flash-low");
  });
});
