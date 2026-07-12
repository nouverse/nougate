import { describe, expect, test } from "bun:test";
import {
  ModelPrefixError,
  requireProviderPrefix,
  resolveModel,
} from "../../src/core/model-resolver";

describe("Model Resolver", () => {
  test("resolveModel parses provider-prefixed model IDs", () => {
    expect(resolveModel("antigravity:gemini-3.5-flash-low")).toEqual({
      providerId: "antigravity",
      modelId: "gemini-3.5-flash-low",
      raw: "antigravity:gemini-3.5-flash-low",
    });
  });

  test("resolveModel preserves bare model IDs without provider", () => {
    expect(resolveModel("gemini-3.5-flash-low")).toEqual({
      providerId: null,
      modelId: "gemini-3.5-flash-low",
      raw: "gemini-3.5-flash-low",
    });
  });

  test("requireProviderPrefix rejects bare model IDs", () => {
    expect(() => requireProviderPrefix(resolveModel("gemini-3.5-flash-low"))).toThrow(
      ModelPrefixError,
    );
  });

  test("requireProviderPrefix accepts provider-prefixed model IDs", () => {
    expect(() =>
      requireProviderPrefix(resolveModel("antigravity:gemini-3.5-flash-low")),
    ).not.toThrow();
  });
});
