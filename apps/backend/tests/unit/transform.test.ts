import { describe, expect, test, beforeAll } from "bun:test";
import { mapOpenAIToGoogle } from "../../src/protocols/openai/mapper-in";
import { transformGoogleEventToOpenAI } from "../../src/protocols/openai/mapper-out";
import { loadProxyConfig } from "../../src/config/manager";
import { loadAntigravityConfig } from "../../src/providers/antigravity";
import type { IModelSpec } from "../../src/core/interfaces";
import { resolveModel } from "../../src/core/model-resolver";
import { OpenAIProtocolHandler } from "../../src/protocols/openai/handler";

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
});

describe("Unit Tests: OpenAIProtocolHandler", () => {
  test("Rejects requests without provider prefix", async () => {
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
        displayName: "Antigravity",
        init: async () => {},
        getBestAccount: async () => null,
        updateAccountUsage: async () => {},
        getAccounts: () => [],
        getModelRegistry: () => ({
          getSpec: () => null,
          listModelIds: () => [],
        }),
      },
      sessionId: "session-handler-test",
      clientId: "client-handler-test",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        code: "model_prefix_required",
      },
    });
  });
});
