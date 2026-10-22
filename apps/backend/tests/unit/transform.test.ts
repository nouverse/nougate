import { describe, expect, test, beforeAll } from "bun:test";
import { mapOpenAIToGoogle } from "@/providers/antigravity/mappers/openai-in";
import { transformGoogleEventToOpenAI } from "@/providers/antigravity/mappers/openai-out";
import { PLACEHOLDER_THOUGHT_SIGNATURE } from "@/providers/antigravity/utils/thought-signature";
import { loadProxyConfig } from "@/config/manager";
import { loadAntigravityConfig } from "@/providers/antigravity";
import type { IModelSpec } from "@/core/interfaces";
import type { JitterConfig } from "@/core/jitter";
import { resolveModel } from "@/core/model-resolver";
import { OpenAIProtocolHandler } from "@/protocols/openai/handler";
import { registerProvider, unregisterProvider } from "@/core/registry";

/**
 * Mocks opt out of the delay: this suite exercises transformation, and the real
 * windows would add seconds of sleep to every handled request.
 */
const NO_JITTER: JitterConfig = { jitterEnabled: false, jitterMinMs: 0, jitterMaxMs: 0 };

beforeAll(async () => {
  await loadProxyConfig();
  await loadAntigravityConfig();
});

/**
 * Build a compact model spec fixture for mapper tests.
 */
function buildModelSpec(overrides: Partial<IModelSpec>): IModelSpec {
  return {
    modelId: "fixture-model",
    pool: "sandbox",
    isThinking: false,
    maxOutputTokens: 4096,
    ...overrides,
  };
}

describe("Unit Tests: mapOpenAIToGoogle", () => {
  test("Basic message transformation", () => {
    const openaiBody = {
      model: "antigravity:gpt-oss-120b",
      messages: [
        { role: "user", content: "Hello Gemini" }
      ],
      temperature: 0.5
    };

    const result = mapOpenAIToGoogle(
      openaiBody,
      buildModelSpec({
        modelId: "gpt-oss-120b",
        pool: "cli",
      }),
      "session-1",
    );

    expect(result.project).toBe("");
    expect(result.model).toBe("gpt-oss-120b");
    expect(result.request.contents).toHaveLength(1);
    expect(result.request.contents[0].role).toBe("user");
    expect(result.request.contents[0].parts[0].text).toBe("Hello Gemini");
    expect(result.request.generationConfig.temperature).toBe(0.5);
  });

  test("Thinking level comes from model spec", () => {
    const openaiBody = {
      model: "antigravity:gemini-3-pro-high",
      messages: [{ role: "user", content: "Hi" }]
    };

    const result = mapOpenAIToGoogle(
      openaiBody,
      buildModelSpec({
        modelId: "gemini-3-pro-high",
        isThinking: true,
        thinkingMode: "level",
        thinkingLevel: "high",
        maxOutputTokens: 64000,
      }),
      "session-2",
    );
    expect(result.model).toBe("gemini-3-pro-high");
    expect(result.request.generationConfig.thinkingConfig.includeThoughts).toBe(true);
    expect(result.request.generationConfig.thinkingConfig.thinkingLevel).toBe("high");
  });

  test("Multi-turn conversation", () => {
    const openaiBody = {
      model: "antigravity:gemini-3-pro",
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
        { role: "user", content: "How are you?" }
      ]
    };

    const result = mapOpenAIToGoogle(
      openaiBody,
      buildModelSpec({
        modelId: "gemini-3-pro",
        isThinking: true,
        thinkingMode: "level",
        thinkingLevel: "low",
        maxOutputTokens: 64000,
      }),
      "session-3",
    );
    expect(result.request.contents).toHaveLength(3);
    expect(result.request.contents[0].role).toBe("user");
    expect(result.request.contents[1].role).toBe("model"); // OpenAI assistant -> Google model
    expect(result.request.contents[2].role).toBe("user");
  });

  test("Tool transformation", () => {
    const openaiBody = {
      model: "antigravity:gemini-3-pro",
      messages: [{ role: "user", content: "Check weather" }],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get weather",
            parameters: {
              type: "object",
              properties: {
                location: { type: "string" }
              },
              required: ["location"]
            }
          }
        }
      ]
    };

    const result = mapOpenAIToGoogle(
      openaiBody,
      buildModelSpec({
        modelId: "gemini-3-pro",
        isThinking: true,
        thinkingMode: "level",
        thinkingLevel: "low",
        maxOutputTokens: 64000,
      }),
      "session-4",
    );
    expect(result.request.tools).toBeDefined();
    expect(result.request.tools[0].functionDeclarations).toHaveLength(1);
    expect(result.request.tools[0].functionDeclarations[0].name).toBe("get_weather");
    expect(result.request.tools[0].functionDeclarations[0].parameters.properties.location).toBeDefined();
  });

  test("Claude Opus 4.6 Thinking mapping and budget", () => {
    const openaiBody = {
      model: "antigravity:claude-opus-4-6",
      messages: [{ role: "user", content: "Hi" }]
    };

    const result = mapOpenAIToGoogle(
      openaiBody,
      buildModelSpec({
        modelId: "claude-opus-4-6",
        upstreamModelId: "claude-opus-4-6-thinking",
        maxOutputTokens: 8192,
      }),
      "session-5",
    );
    expect(result.model).toBe("claude-opus-4-6-thinking");
    expect(result.request.generationConfig.thinkingConfig).toBeUndefined();
  });

  test("Claude Opus 4.6 explicit thinking budget", () => {
    const openaiBody = {
      model: "antigravity:claude-opus-4-6-thinking",
      messages: [{ role: "user", content: "Hi" }],
      thinking: {
        type: "enabled",
        budget_tokens: 8192,
      },
    };

    const result = mapOpenAIToGoogle(
      openaiBody,
      buildModelSpec({
        modelId: "claude-opus-4-6-thinking",
        isThinking: true,
        thinkingMode: "budget",
        thinkingBudget: 32768,
        maxOutputTokens: 64000,
      }),
      "session-6",
    );
    expect(result.request.generationConfig.thinkingConfig.thinkingBudget).toBe(8192);
  });

  test("Claude tool call transformation with ID", () => {
    const openaiBody = {
      model: "antigravity:claude-opus-4-6-thinking",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_abc123",
              type: "function",
              function: { name: "test_tool", arguments: "{}" }
            }
          ]
        }
      ]
    };

    const result = mapOpenAIToGoogle(
      openaiBody,
      buildModelSpec({
        modelId: "claude-opus-4-6-thinking",
        isThinking: true,
        thinkingMode: "budget",
        thinkingBudget: 32768,
        maxOutputTokens: 64000,
      }),
      "session-7",
    );
    const funcCallPart = result.request.contents[0].parts.find((p: any) => p.functionCall);
    expect(funcCallPart).toBeDefined();
    expect(funcCallPart.functionCall.id).toBe("call_abc123");
  });

  test("Claude tool response transformation with ID", () => {
    const openaiBody = {
      model: "antigravity:claude-opus-4-6-thinking",
      messages: [
        {
          role: "tool",
          tool_call_id: "call_abc123",
          name: "test_tool",
          content: '{"result": "ok"}'
        }
      ]
    };

    const result = mapOpenAIToGoogle(
      openaiBody,
      buildModelSpec({
        modelId: "claude-opus-4-6-thinking",
        isThinking: true,
        thinkingMode: "budget",
        thinkingBudget: 32768,
        maxOutputTokens: 64000,
      }),
      "session-8",
    );
    const funcRespPart = result.request.contents[0].parts.find((p: any) => p.functionResponse);
    expect(funcRespPart).toBeDefined();
    expect(funcRespPart.functionResponse.id).toBe("call_abc123");
  });

  /**
   * Gemini 3 rejects the whole request when the leading functionCall part of a
   * turn has no thought_signature. An uncached call keeps its real shape and
   * borrows the documented validation-skip placeholder instead of being rendered
   * as prose — prose in the context taught the model to answer with
   * "[Tool Result: ...]" text of its own.
   */
  test("Gemini 3 signs unsigned tool calls with the validation-skip placeholder", () => {
    const openaiBody = {
      model: "antigravity:gemini-3.8-flash",
      messages: [
        { role: "user", content: "analyse this image" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call256486",
              type: "function",
              function: { name: "image", arguments: '{"path":"a.png"}' },
            },
            {
              id: "call256487",
              type: "function",
              function: { name: "exec", arguments: '{"cmd":"ls"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call256486", name: "image", content: '{"caption":"a cat"}' },
        { role: "tool", tool_call_id: "call256487", name: "exec", content: "a.png" },
      ],
    };

    const result = mapOpenAIToGoogle(
      openaiBody,
      buildModelSpec({ modelId: "gemini-3.8-flash", isThinking: true }),
      "session-signature-gap",
    );

    const allParts = result.request.contents.flatMap((content: any) => content.parts);
    const functionCalls = allParts.filter((part: any) => part.functionCall);
    const functionResponses = allParts.filter((part: any) => part.functionResponse);

    // Structure survives: both calls and both results stay machine-readable.
    expect(functionCalls.map((part: any) => part.functionCall.name)).toEqual(["image", "exec"]);
    expect(functionResponses).toHaveLength(2);
    expect(functionResponses[0].functionResponse.response).toEqual({ caption: "a cat" });

    // Only the leading call carries a signature — that is the part upstream validates.
    expect(functionCalls[0].thoughtSignature).toBe(PLACEHOLDER_THOUGHT_SIGNATURE);
    expect(functionCalls[0].thought_signature).toBe(PLACEHOLDER_THOUGHT_SIGNATURE);
    expect(functionCalls[1].thoughtSignature).toBeUndefined();

    // Nothing anywhere in the payload teaches the model to write tool traffic as text.
    const text = allParts
      .filter((part: any) => typeof part.text === "string")
      .map((part: any) => part.text)
      .join("\n");
    expect(text).not.toContain("[Tool Call:");
    expect(text).not.toContain("[Tool Result:");
  });

  test("Non-Gemini-3 thinking models get no placeholder signature", () => {
    const openaiBody = {
      model: "antigravity:claude-opus-4-6-thinking",
      messages: [
        { role: "user", content: "run it" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call555", type: "function", function: { name: "exec", arguments: "{}" } },
          ],
        },
      ],
    };

    const result = mapOpenAIToGoogle(
      openaiBody,
      buildModelSpec({
        modelId: "claude-opus-4-6-thinking",
        isThinking: true,
        thinkingMode: "budget",
        thinkingBudget: 32768,
      }),
      "session-claude-no-placeholder",
    );

    const allParts = result.request.contents.flatMap((content: any) => content.parts);
    const funcCallPart = allParts.find((part: any) => part.functionCall);
    expect(funcCallPart).toBeDefined();
    expect(funcCallPart.thoughtSignature).toBeUndefined();
  });

  test("Non-thinking Gemini 3 keeps unsigned tool calls as function calls", () => {
    const openaiBody = {
      model: "antigravity:gemini-3.8-flash",
      messages: [
        { role: "user", content: "run it" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call999", type: "function", function: { name: "exec", arguments: "{}" } },
          ],
        },
      ],
    };

    const result = mapOpenAIToGoogle(
      openaiBody,
      buildModelSpec({ modelId: "gemini-3.8-flash", isThinking: false }),
      "session-no-thinking",
    );

    const allParts = result.request.contents.flatMap((content: any) => content.parts);
    const funcCallPart = allParts.find((part: any) => part.functionCall);
    expect(funcCallPart).toBeDefined();
    expect(funcCallPart.functionCall.id).toBe("call999");
  });
});

describe("Unit Tests: transformGoogleEventToOpenAI", () => {
  test("Basic text response", () => {
    const googleData = {
      candidates: [{
        content: {
          parts: [{ text: "Hello world" }]
        },
        finishReason: "STOP"
      }]
    };

    const result = transformGoogleEventToOpenAI(googleData, "gemini-1.5-pro", "req-123");
    expect(result).not.toBeNull();
    expect(result.choices[0].delta.content).toBe("Hello world");
    expect(result.choices[0].finish_reason).toBe("stop");
  });

  test("Tool call response", () => {
    const googleData = {
      candidates: [{
        content: {
          parts: [{
            functionCall: {
              name: "get_weather",
              args: { location: "London" }
            }
          }]
        }
      }]
    };

    const result = transformGoogleEventToOpenAI(googleData, "gemini-1.5-pro");
    expect(result.choices[0].delta.tool_calls).toHaveLength(1);
    expect(result.choices[0].delta.tool_calls[0].function.name).toBe("get_weather");
    expect(JSON.parse(result.choices[0].delta.tool_calls[0].function.arguments).location).toBe("London");
  });

  test("Empty/Invalid response", () => {
    const googleData = { candidates: [] };
    const result = transformGoogleEventToOpenAI(googleData, "model");
    expect(result).toBeNull();
  });

  /**
   * Gemini reports a prompt-cache hit as `cachedContentTokenCount`, counted inside
   * `promptTokenCount`. This mapper copied the three totals and dropped it, so every cached token was
   * billed downstream at full price — `metrics/tracker.ts` reads `prompt_tokens_details.cached_tokens`
   * and reprices at 0.1x, and never once saw the field.
   */
  test("a cache hit reaches the client as prompt_tokens_details", () => {
    const googleData = {
      candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }],
      usageMetadata: {
        promptTokenCount: 20000,
        candidatesTokenCount: 50,
        totalTokenCount: 20050,
        cachedContentTokenCount: 18000,
      },
    };

    const result = transformGoogleEventToOpenAI(googleData, "gemini-1.5-pro");
    expect(result.usage.prompt_tokens).toBe(20000);
    expect(result.usage.prompt_tokens_details.cached_tokens).toBe(18000);
  });

  test("and an upstream that says nothing about caching leaves the key off", () => {
    // Absent and zero are different facts. Only zero means the cache had no hits; absent means nobody
    // reported, which is what this proxy looked like before the field was mapped.
    const googleData = {
      candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 },
    };

    const result = transformGoogleEventToOpenAI(googleData, "gemini-1.5-pro");
    expect(result.usage.prompt_tokens).toBe(10);
    expect(result.usage).not.toHaveProperty("prompt_tokens_details");
  });
});

describe("Unit Tests: OpenAIProtocolHandler", () => {
  test("An unprefixed model no provider serves is a 400 that names the fix", async () => {
    const handler = new OpenAIProtocolHandler();
    const req = new Request("http://localhost:3000/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gemini-3-flash",
        messages: [{ role: "user", content: "Hello" }],
      }),
    });

    const response = await handler.handle({
      req,
      url: new URL(req.url),
      protocol: "openai",
      resolvedModel: resolveModel("gemini-3-flash"),
      provider: {
        id: "antigravity",
        displayName: "Google Antigravity",
        init: async () => {},
        getJitterConfig: () => NO_JITTER,
        getBestAccount: async () => null,
        updateAccountUsage: async () => {},
        getAccounts: () => [],
        getModelRegistry: () => ({
          getSpec: () => null,
          listModelIds: () => [],
        }),
        getSupportedModels: () => [],
        execute: async () => new Response("Mock"),
      },
      sessionId: "session-handler-test",
      clientId: "client-handler-test",
    });

    // A bare model id is a routing question now, not a rejection: it is refused only when nothing
    // in the registry serves it, and the message points at /v1/models rather than at prefix syntax.
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toMatchObject({ error: { code: "model_not_found" } });
    expect(body.error.message).toContain("gemini-3-flash");
  });

  test("Lists models from every registered provider, sorted by ID", async () => {
    // Model listing reads the registry rather than the request's provider, so a
    // client sees every prefix it can call — including custom providers.
    const makeProvider = (id: string, modelIds: string[]) => ({
      id,
      displayName: id,
      init: async () => {},
      getJitterConfig: () => NO_JITTER,
      getBestAccount: async () => null,
      updateAccountUsage: async () => {},
      getAccounts: () => [],
      getModelRegistry: () => ({
        getSpec: () => null,
        listModelIds: () => modelIds,
      }),
      getSupportedModels: () => modelIds,
      execute: async () => new Response("Mock"),
    });

    registerProvider(makeProvider("antigravity", ["gemini-3.5-flash-low", "claude-sonnet-4-6"]));
    registerProvider(makeProvider("deepseek", ["deepseek-v4-flash"]));

    try {
      const handler = new OpenAIProtocolHandler();
      const req = new Request("http://localhost:3000/openai/v1/models", {
        method: "GET",
      });

      const response = await handler.handle({
        req,
        url: new URL(req.url),
        protocol: "openai",
        resolvedModel: resolveModel(""),
        provider: makeProvider("antigravity", []),
        sessionId: "session-handler-test",
        clientId: "client-handler-test",
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.object).toBe("list");
      expect(body.data).toHaveLength(3);

      expect(body.data.map((entry: any) => entry.id)).toEqual([
        "antigravity:claude-sonnet-4-6",
        "antigravity:gemini-3.5-flash-low",
        "deepseek:deepseek-v4-flash",
      ]);
      expect(body.data[0].legacy_id).toBe("antigravity-claude-sonnet-4-6");
      expect(body.data[0].provider).toBe("antigravity");
      expect(body.data[2].provider).toBe("deepseek");
    } finally {
      unregisterProvider("antigravity");
      unregisterProvider("deepseek");
    }
  });
});
