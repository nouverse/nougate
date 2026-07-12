import { describe, expect, test } from "bun:test";
import { antigravityModelRegistry } from "../../src/providers/antigravity/config/model-specs";

describe("Antigravity Model Registry", () => {
  test("getSpec returns a model spec for a known model", () => {
    const modelSpec = antigravityModelRegistry.getSpec("gemini-3.5-flash-low");

    expect(modelSpec).not.toBeNull();
    expect(modelSpec?.modelId).toBe("gemini-3.5-flash-low");
    expect(modelSpec?.pool).toBe("sandbox");
  });

  test("getSpec returns null for an unknown model", () => {
    expect(antigravityModelRegistry.getSpec("nonexistent-model")).toBeNull();
  });

  test("listModelIds returns provider-local model IDs", () => {
    const modelIds = antigravityModelRegistry.listModelIds();

    expect(Array.isArray(modelIds)).toBe(true);
    expect(modelIds).toContain("gemini-3.5-flash-low");
  });
});
