
import { describe, expect, test, beforeAll } from "bun:test";
import {
  mapOpenAIToGoogle,
  transformGoogleEventToOpenAI,
} from "../../src/protocols/openai";
import { loadProxyConfig } from "../../src/config/manager";
import { getModelSpec } from "../../src/providers/antigravity/config/model-specs";

beforeAll(async () => {
  await loadProxyConfig();
});

/**
 * Read a model spec and fail loudly when the fixture model does not exist.
 */
function requireModelSpec(modelId: string) {
  const modelSpec = getModelSpec(modelId);
  expect(modelSpec).not.toBeNull();
  return modelSpec!;
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
      requireModelSpec("gpt-oss-120b"),
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
      requireModelSpec("gemini-3-pro-high"),
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
      requireModelSpec("gemini-3-pro"),
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
      requireModelSpec("gemini-3-pro"),
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
      requireModelSpec("claude-opus-4-6"),
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
      requireModelSpec("claude-opus-4-6-thinking"),
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
      requireModelSpec("claude-opus-4-6-thinking"),
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
      requireModelSpec("claude-opus-4-6-thinking"),
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
