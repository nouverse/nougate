/**
 * A model's context window, stated where a route knows it and nowhere else (G2): what Nouride budgets a conversation by.
 *
 * Invariant 5 is the whole of the design here. A window a route does not know is left out of `/models`, so the client
 * falls back to its own table — a guessed one would be indistinguishable from a real one, and a client sizes every
 * request by it.
 */

import { describe, expect, test } from "bun:test";
import type { IModelRegistry, IModelSpec, IProvider } from "@/core/interfaces";
import type { JitterConfig } from "@/core/jitter";
import { resolveModel } from "@/core/model-resolver";
import { OpenAIProtocolHandler } from "@/protocols/openai/handler";
import { AnthropicProtocolHandler } from "@/protocols/anthropic/handler";
import { registerProvider, unregisterProvider } from "@/core/registry";
import { catalogToModelDefs, kiroModelRegistry } from "@/providers/kiro/config/model-specs";
import { upstreamWindow } from "@/providers/custom/model-sync";

const NO_JITTER: JitterConfig = { jitterEnabled: false, jitterMinMs: 0, jitterMaxMs: 0 };

function registry(specs: IModelSpec[]): IModelRegistry {
  const byId = new Map(specs.map((spec) => [spec.modelId, spec]));
  return { getSpec: (id) => byId.get(id) ?? null, listModelIds: () => [...byId.keys()].sort() };
}

function provider(id: string, models: IModelRegistry): IProvider {
  return {
    id,
    displayName: id,
    init: async () => {},
    getJitterConfig: () => NO_JITTER,
    getBestAccount: async () => null,
    updateAccountUsage: async () => {},
    getAccounts: () => [],
    getModelRegistry: () => models,
    getSupportedModels: () => models.listModelIds(),
    execute: async () => new Response("Mock"),
  };
}

const spec = (modelId: string, extra: Partial<IModelSpec> = {}): IModelSpec => ({ modelId, pool: "cli", isThinking: false, maxOutputTokens: 8192, ...extra });

async function listing(handler: OpenAIProtocolHandler | AnthropicProtocolHandler, path: string): Promise<Map<string, any>> {
  const req = new Request(`http://localhost:3000${path}`, { method: "GET" });
  const response = await handler.handle({
    req,
    url: new URL(req.url),
    protocol: handler.protocol,
    resolvedModel: resolveModel(""),
    provider: provider("ctx", registry([])),
    sessionId: "session-models",
    clientId: "client-models",
  });
  expect(response.status).toBe(200);
  return new Map((await response.json()).data.map((entry: any) => [entry.id, entry]));
}

describe("/models states a model's window where the route knows it, and only there", () => {
  for (const [label, handler, path] of [
    ["OpenAI", new OpenAIProtocolHandler(), "/openai/v1/models"],
    ["Anthropic", new AnthropicProtocolHandler(), "/anthropic/v1/models"],
  ] as const) {
    test(label, async () => {
      registerProvider(provider("ctx", registry([spec("known", { contextWindow: 1_000_000 }), spec("unknown"), spec("broken", { contextWindow: 0 })])));
      try {
        const models = await listing(handler, path);
        expect(models.get("ctx:known").context_window).toBe(1_000_000);
        expect(models.get("ctx:unknown")).not.toHaveProperty("context_window");
        expect(models.get("ctx:broken")).not.toHaveProperty("context_window");
      } finally {
        unregisterProvider("ctx");
      }
    });
  }
});

describe("Kiro", () => {
  test("its specs carry the window its catalogue states", () => {
    expect(kiroModelRegistry.getSpec("claude-opus-5.5")?.contextWindow).toBe(1_000_000);
    expect(kiroModelRegistry.getSpec("claude-sonnet-4.5")?.contextWindow).toBe(200_000);
  });

  test("a live catalogue's `tokenLimits` reaches a model the static list does not know, and nothing is made up without it", () => {
    const defs = catalogToModelDefs([
      { modelId: "brand-new-model", modelName: "Brand New", tokenLimits: { maxInputTokens: 400_000 } },
      { modelId: "silent-model", modelName: "Silent" },
    ]);
    expect(defs.find((def) => def.id === "brand-new-model")?.contextLength).toBe(400_000);
    expect(defs.find((def) => def.id === "silent-model")?.contextLength).toBeUndefined();
  });
});

describe("a custom upstream's listing", () => {
  test("names a window in each of the ways upstreams do, and a number that is not one is none", () => {
    expect(upstreamWindow({ id: "a", context_window: 128_000 })).toBe(128_000);
    expect(upstreamWindow({ id: "b", context_length: 200_000 })).toBe(200_000);
    expect(upstreamWindow({ id: "c", top_provider: { context_length: 65_536 } })).toBe(65_536);
    expect(upstreamWindow({ id: "d", max_model_len: 32_768 })).toBe(32_768);
    expect(upstreamWindow({ id: "e", max_context_length: 8_192 })).toBe(8_192);
    expect(upstreamWindow({ id: "f" })).toBeUndefined();
    expect(upstreamWindow({ id: "g", context_length: 1_000.5 })).toBeUndefined();
    expect(upstreamWindow({ id: "h", context_length: 512 })).toBeUndefined();
    expect(upstreamWindow({ id: "i", context_length: "128k" })).toBeUndefined();
  });
});
