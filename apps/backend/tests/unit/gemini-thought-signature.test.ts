import { describe, expect, test, beforeAll } from "bun:test";
import { mapAnthropicToGoogle } from "@/providers/antigravity/mappers/anthropic-in";
import { createAnthropicStreamTransformer } from "@/providers/antigravity/mappers/anthropic-out";
import { PLACEHOLDER_THOUGHT_SIGNATURE } from "@/providers/antigravity/utils/thought-signature";
import { loadProxyConfig } from "@/config/manager";
import { loadAntigravityConfig } from "@/providers/antigravity";
import type { IModelSpec } from "@/core/interfaces";

/**
 * Gemini 3 rejects a request whose leading functionCall part carries no
 * thought_signature, and only upstream can mint one. A call the gateway never
 * issued itself — a client that regenerates tool IDs, a history replayed past
 * cache eviction — therefore has nothing to replay.
 *
 * The earlier answer was to rewrite those turns as `[Tool Call: …]` /
 * `[Tool Result: …]` prose. That made the model *answer in that format*: clients
 * got a text block containing a fake tool result instead of a tool call, and the
 * real result was truncated to 500 characters on the way in. The signature
 * placeholder keeps the wire shape intact instead.
 */

const GEMINI_3_THINKING: IModelSpec = {
  modelId: "gemini-3.6-flash-medium",
  pool: "sandbox",
  isThinking: true,
  thinkingMode: "level",
  thinkingLevel: "medium",
  maxOutputTokens: 64000,
  timeoutMs: 60000,
};

beforeAll(async () => {
  await loadProxyConfig();
  await loadAntigravityConfig();
});

describe("Anthropic → Google: unsigned tool_use blocks", () => {
  const longResult = "x".repeat(4000);

  const body = {
    model: "antigravity:gemini-3.6-flash-medium",
    max_tokens: 4096,
    messages: [
      { role: "user" as const, content: "fetch the docs page and summarise it" },
      {
        role: "assistant" as const,
        content: [
          { type: "tool_use" as const, id: "toolu_from_another_gateway", name: "web_fetch", input: { url: "https://example.com" } },
          { type: "tool_use" as const, id: "toolu_second_in_turn", name: "clock", input: {} },
        ],
      },
      {
        role: "user" as const,
        content: [
          { type: "tool_result" as const, tool_use_id: "toolu_from_another_gateway", content: longResult },
          { type: "tool_result" as const, tool_use_id: "toolu_second_in_turn", content: "12:00" },
        ],
      },
    ],
  };

  test("the lead call carries the placeholder and the turn keeps its shape", () => {
    const result = mapAnthropicToGoogle(body, GEMINI_3_THINKING, "session-anthropic-unsigned");
    const parts = result.request.contents.flatMap((content: any) => content.parts);
    const functionCalls = parts.filter((part: any) => part.functionCall);

    expect(functionCalls.map((part: any) => part.functionCall.name)).toEqual(["web_fetch", "clock"]);
    expect(functionCalls[0].thoughtSignature).toBe(PLACEHOLDER_THOUGHT_SIGNATURE);
    expect(functionCalls[0].thought_signature).toBe(PLACEHOLDER_THOUGHT_SIGNATURE);
    // Upstream attaches — and validates — a signature on the leading call only.
    expect(functionCalls[1].thoughtSignature).toBeUndefined();
  });

  test("tool results reach upstream whole, not truncated into prose", () => {
    const result = mapAnthropicToGoogle(body, GEMINI_3_THINKING, "session-anthropic-unsigned");
    const parts = result.request.contents.flatMap((content: any) => content.parts);
    const responses = parts.filter((part: any) => part.functionResponse);

    expect(responses).toHaveLength(2);
    expect(responses[0].functionResponse.response.result).toBe(longResult);

    const text = parts
      .filter((part: any) => typeof part.text === "string")
      .map((part: any) => part.text)
      .join("\n");
    expect(text).not.toContain("[Tool Call:");
    expect(text).not.toContain("[Tool Result:");
    expect(text).not.toContain("[truncated]");
  });

  test("a non-Gemini-3 upstream gets no invented signature", () => {
    const result = mapAnthropicToGoogle(
      { ...body, model: "antigravity:claude-opus-4-6-thinking" },
      { ...GEMINI_3_THINKING, modelId: "claude-opus-4-6-thinking", thinkingMode: "budget", thinkingBudget: 32768 },
      "session-anthropic-claude",
    );
    const parts = result.request.contents.flatMap((content: any) => content.parts);
    const functionCalls = parts.filter((part: any) => part.functionCall);

    expect(functionCalls).toHaveLength(2);
    expect(functionCalls[0].thoughtSignature).toBeUndefined();
  });
});

describe("Google → Anthropic stream: stop_reason for tool calls", () => {
  async function run(events: unknown[]): Promise<string> {
    const encoder = new TextEncoder();
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
        controller.close();
      },
    });

    const out = source.pipeThrough(
      createAnthropicStreamTransformer("gemini-3.6-flash-medium", "msg_test") as any,
    );

    let text = "";
    const decoder = new TextDecoder();
    const reader = (out as ReadableStream<Uint8Array>).getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    return text;
  }

  function stopReason(sse: string): string | undefined {
    const line = sse
      .split("\n")
      .find((l) => l.startsWith("data: ") && l.includes('"type":"message_delta"'));
    return line ? JSON.parse(line.slice(6)).delta?.stop_reason : undefined;
  }

  /**
   * Anthropic clients run the tool because stop_reason says tool_use. Reporting
   * end_turn alongside a tool_use block ends their agent loop instead.
   */
  test("a functionCall turn ends as tool_use", async () => {
    const sse = await run([
      {
        candidates: [
          { content: { parts: [{ functionCall: { id: "call_1", name: "web_fetch", args: { url: "https://example.com" } } }] } },
        ],
      },
      { candidates: [{ content: { parts: [] }, finishReason: "STOP" }] },
    ]);

    expect(sse).toContain('"type":"tool_use"');
    expect(stopReason(sse)).toBe("tool_use");
  });

  test("a plain text turn still ends as end_turn", async () => {
    const sse = await run([
      { candidates: [{ content: { parts: [{ text: "hello" }] }, finishReason: "STOP" }] },
    ]);

    expect(stopReason(sse)).toBe("end_turn");
  });

  test("truncation still outranks nothing but keeps its own reason", async () => {
    const sse = await run([
      { candidates: [{ content: { parts: [{ text: "half a sen" }] }, finishReason: "MAX_TOKENS" }] },
    ]);

    expect(stopReason(sse)).toBe("max_tokens");
  });
});
