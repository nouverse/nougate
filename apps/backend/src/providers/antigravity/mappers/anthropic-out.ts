import { cacheSignature, cacheSignatureByCallId, cacheSessionSignature, cacheThinkingFamily, cacheSessionReasoning } from "@/providers/antigravity/utils/signature-cache";
import { anthropicCacheUsage, cacheReadTokens } from "@/core/usage-cache";
import { getFamilyName } from "@/providers/antigravity/auth/manager";

/**
 * Google SSE → Anthropic SSE transform.
 * Anthropic event sequence:
 *   message_start → content_block_start → content_block_delta(s) → content_block_stop → message_delta → message_stop
 */
export function createAnthropicStreamTransformer(model: string, messageId: string, sessionId?: string, messageCount?: number, assistantTurnIndex?: number) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let blockIndex = 0;
  let currentBlockType: "text" | "thinking" | "tool_use" | null = null;

  let activeSignature: string | undefined;
  let activeThought = "";
  // Anthropic clients decide whether to run the tool from stop_reason, not from
  // the presence of a tool_use block — "end_turn" ends their agent loop.
  let sawToolUse = false;

  return new TransformStream({
    start(controller) {
      const msgStart = {
        type: "message_start",
        message: {
          id: messageId,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      };
      controller.enqueue(encoder.encode(sseEvent("message_start", msgStart)));
    },

    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        const dataStr = trimmed.slice(6);
        if (dataStr === "[DONE]") continue;

        try {
          const googleEvent = JSON.parse(dataStr);
          const data = googleEvent.response ?? googleEvent;
          const parts = data.candidates?.[0]?.content?.parts ?? [];
          const finishReason = data.candidates?.[0]?.finishReason;
          const usage = data.usageMetadata;

          for (const part of parts) {
            const isThought = part.thought || part.thoughtText || part.type === "thinking";
            const sig = part.thoughtSignature || part.thought_signature || part.signature;

            if (sig) {
              activeSignature = sig;
            }

            if (part.text && isThought) {
              activeThought += part.text;
              if (currentBlockType !== "thinking") {
                if (currentBlockType !== null) {
                  controller.enqueue(encoder.encode(sseEvent("content_block_stop", { type: "content_block_stop", index: blockIndex })));
                  blockIndex++;
                }
                controller.enqueue(encoder.encode(sseEvent("content_block_start", {
                  type: "content_block_start",
                  index: blockIndex,
                  content_block: { type: "thinking", thinking: "", signature: sig ?? "" },
                })));
                currentBlockType = "thinking";
              }
              controller.enqueue(encoder.encode(sseEvent("content_block_delta", {
                type: "content_block_delta",
                index: blockIndex,
                delta: { type: "thinking_delta", thinking: part.text },
              })));
            } else if (part.text) {
              if (currentBlockType !== "text") {
                if (currentBlockType !== null) {
                  controller.enqueue(encoder.encode(sseEvent("content_block_stop", { type: "content_block_stop", index: blockIndex })));
                  blockIndex++;
                }
                controller.enqueue(encoder.encode(sseEvent("content_block_start", {
                  type: "content_block_start",
                  index: blockIndex,
                  content_block: { type: "text", text: "" },
                })));
                currentBlockType = "text";
              }
              controller.enqueue(encoder.encode(sseEvent("content_block_delta", {
                type: "content_block_delta",
                index: blockIndex,
                delta: { type: "text_delta", text: part.text },
              })));
            } else if (part.functionCall || part.function_call) {
              const call = part.functionCall ?? part.function_call;
              if (currentBlockType !== null) {
                controller.enqueue(encoder.encode(sseEvent("content_block_stop", { type: "content_block_stop", index: blockIndex })));
                blockIndex++;
              }
              const toolId = call.id ?? `toolu_${Math.random().toString(36).slice(2, 10)}`;
              sawToolUse = true;
              if (activeSignature) {
                cacheSignatureByCallId(toolId, activeSignature);
              }
              controller.enqueue(encoder.encode(sseEvent("content_block_start", {
                type: "content_block_start",
                index: blockIndex,
                content_block: { type: "tool_use", id: toolId, name: call.name, input: {} },
              })));
              const inputStr = typeof call.args === "string" ? call.args : JSON.stringify(call.args ?? {});
              controller.enqueue(encoder.encode(sseEvent("content_block_delta", {
                type: "content_block_delta",
                index: blockIndex,
                delta: { type: "input_json_delta", partial_json: inputStr },
              })));
              controller.enqueue(encoder.encode(sseEvent("content_block_stop", { type: "content_block_stop", index: blockIndex })));
              blockIndex++;
              currentBlockType = null;
            }
          }

          if (sessionId && activeSignature && activeThought) {
            cacheSignature(sessionId, activeThought, activeSignature);
          }

          if (finishReason) {
            if (currentBlockType !== null) {
              controller.enqueue(encoder.encode(sseEvent("content_block_stop", { type: "content_block_stop", index: blockIndex })));
              currentBlockType = null;
            }
            const stopReason = sawToolUse ? "tool_use"
              : finishReason === "MAX_TOKENS" ? "max_tokens"
              : "end_turn";
            controller.enqueue(encoder.encode(sseEvent("message_delta", {
              type: "message_delta",
              delta: { stop_reason: stopReason, stop_sequence: null },
              usage: {
                input_tokens: usage?.promptTokenCount ?? 0,
                output_tokens: usage?.candidatesTokenCount ?? 0,
                ...anthropicCacheUsage(cacheReadTokens(usage)),
              },
            })));
          }
        } catch (e) {
          console.warn("[Anthropic Stream] Failed to parse chunk:", e);
        }
      }
    },

    flush(controller) {
      if (buffer.trim()) {
        const trimmed = buffer.trim();
        if (trimmed.startsWith("data: ") && trimmed !== "data: [DONE]") {
          try {
            const dataStr = trimmed.slice(6);
            const googleEvent = JSON.parse(dataStr);
            const data = googleEvent.response ?? googleEvent;
            const parts = data.candidates?.[0]?.content?.parts ?? [];
            const finishReason = data.candidates?.[0]?.finishReason;
            const usage = data.usageMetadata;

            for (const part of parts) {
              const isThought = part.thought || part.thoughtText || part.type === "thinking";
              const sig = part.thoughtSignature || part.thought_signature || part.signature;

              if (sig) {
                activeSignature = sig;
              }

              if (part.text && isThought) {
                activeThought += part.text;
                if (currentBlockType !== "thinking") {
                  if (currentBlockType !== null) {
                    controller.enqueue(encoder.encode(sseEvent("content_block_stop", { type: "content_block_stop", index: blockIndex })));
                    blockIndex++;
                  }
                  controller.enqueue(encoder.encode(sseEvent("content_block_start", {
                    type: "content_block_start",
                    index: blockIndex,
                    content_block: { type: "thinking", thinking: "", signature: sig ?? "" },
                  })));
                  currentBlockType = "thinking";
                }
                controller.enqueue(encoder.encode(sseEvent("content_block_delta", {
                  type: "content_block_delta",
                  index: blockIndex,
                  delta: { type: "thinking_delta", thinking: part.text },
                })));
              } else if (part.text) {
                if (currentBlockType !== "text") {
                  if (currentBlockType !== null) {
                    controller.enqueue(encoder.encode(sseEvent("content_block_stop", { type: "content_block_stop", index: blockIndex })));
                    blockIndex++;
                  }
                  controller.enqueue(encoder.encode(sseEvent("content_block_start", {
                    type: "content_block_start",
                    index: blockIndex,
                    content_block: { type: "text", text: "" },
                  })));
                  currentBlockType = "text";
                }
                controller.enqueue(encoder.encode(sseEvent("content_block_delta", {
                  type: "content_block_delta",
                  index: blockIndex,
                  delta: { type: "text_delta", text: part.text },
                })));
              } else if (part.functionCall || part.function_call) {
                const call = part.functionCall ?? part.function_call;
                if (currentBlockType !== null) {
                  controller.enqueue(encoder.encode(sseEvent("content_block_stop", { type: "content_block_stop", index: blockIndex })));
                  blockIndex++;
                }
                const toolId = call.id ?? `toolu_${Math.random().toString(36).slice(2, 10)}`;
                sawToolUse = true;
                if (activeSignature) {
                  cacheSignatureByCallId(toolId, activeSignature);
                }
                controller.enqueue(encoder.encode(sseEvent("content_block_start", {
                  type: "content_block_start",
                  index: blockIndex,
                  content_block: { type: "tool_use", id: toolId, name: call.name, input: {} },
                })));
                const inputStr = typeof call.args === "string" ? call.args : JSON.stringify(call.args ?? {});
                controller.enqueue(encoder.encode(sseEvent("content_block_delta", {
                  type: "content_block_delta",
                  index: blockIndex,
                  delta: { type: "input_json_delta", partial_json: inputStr },
                })));
                controller.enqueue(encoder.encode(sseEvent("content_block_stop", { type: "content_block_stop", index: blockIndex })));
                blockIndex++;
                currentBlockType = null;
              }
            }

            if (sessionId && activeSignature && activeThought) {
              cacheSignature(sessionId, activeThought, activeSignature);
              cacheThinkingFamily(activeSignature, getFamilyName(model));
              if (messageCount !== undefined) {
                cacheSessionSignature(sessionId, activeSignature, messageCount);
              }
              if (assistantTurnIndex !== undefined) {
                cacheSessionReasoning(sessionId, activeThought, assistantTurnIndex);
              }
            }

            if (finishReason) {
              if (currentBlockType !== null) {
                controller.enqueue(encoder.encode(sseEvent("content_block_stop", { type: "content_block_stop", index: blockIndex })));
                currentBlockType = null;
              }
              const stopReason = sawToolUse ? "tool_use"
                : finishReason === "MAX_TOKENS" ? "max_tokens"
                : "end_turn";
              controller.enqueue(encoder.encode(sseEvent("message_delta", {
                type: "message_delta",
                delta: { stop_reason: stopReason, stop_sequence: null },
                usage: {
                  input_tokens: usage?.promptTokenCount ?? 0,
                  output_tokens: usage?.candidatesTokenCount ?? 0,
                  ...anthropicCacheUsage(cacheReadTokens(usage)),
                },
              })));
            }
          } catch (e) {
            console.warn("[Anthropic Stream] Failed to parse final chunk in flush:", e);
          }
        }
      }
      controller.enqueue(encoder.encode(sseEvent("message_stop", { type: "message_stop" })));
    },
  });
}

function sseEvent(event: string, data: any): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Aggregate streaming response menjadi single Anthropic response object.
 * Dipakai untuk non-streaming request.
 */
export async function aggregateAnthropicResponse(
  googleRes: Response,
  model: string,
  messageId: string,
  sessionId?: string,
  messageCount?: number,
  assistantTurnIndex?: number,
): Promise<any> {
  const decoder = new TextDecoder();
  let text = "";
  let thinking = "";
  const toolUses: any[] = [];
  let stopReason = "end_turn";
  let inputTokens = 0;
  let outputTokens = 0;
  /**
   * Cache-read tokens, `undefined` until the upstream mentions them.
   *
   * Not initialised to 0: a zero here would tell the client the upstream reported "no cache hits"
   * when in fact it reported nothing, and those are different facts — see `core/usage-cache.ts`.
   */
  let cachedTokens: number | undefined;
  let activeSignature = "";

  const reader = googleRes.body!.getReader();
  let buf = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        const dataStr = trimmed.slice(6);
        if (dataStr === "[DONE]") continue;

        try {
          const g = JSON.parse(dataStr);
          const data = g.response ?? g;
          for (const part of data.candidates?.[0]?.content?.parts ?? []) {
            const isThought = part.thought || part.thoughtText || part.type === "thinking";
            const sig = part.thoughtSignature || part.thought_signature || part.signature;

            if (sig) {
              activeSignature = sig;
            }

            if (isThought && part.text) {
              thinking += part.text;
            } else if (part.text) {
              text += part.text;
            } else if (part.functionCall || part.function_call) {
              const call = part.functionCall ?? part.function_call;
              const toolId = call.id ?? `toolu_${Math.random().toString(36).slice(2, 10)}`;
              if (activeSignature) {
                cacheSignatureByCallId(toolId, activeSignature);
              }
              toolUses.push({
                type: "tool_use",
                id: toolId,
                name: call.name,
                input: typeof call.args === "string" ? JSON.parse(call.args) : (call.args ?? {}),
              });
            }
          }
          if (data.candidates?.[0]?.finishReason) {
            const fr = data.candidates[0].finishReason;
            stopReason = fr === "STOP" ? "end_turn" : fr === "MAX_TOKENS" ? "max_tokens" : "end_turn";
          }
          if (data.usageMetadata) {
            inputTokens = data.usageMetadata.promptTokenCount ?? 0;
            outputTokens = data.usageMetadata.candidatesTokenCount ?? 0;
            cachedTokens = cacheReadTokens(data.usageMetadata) ?? cachedTokens;
          }
        } catch (e) { /* ignore */ }
      }
    }
  } finally {
    // Release the upstream connection even when the loop exits by throwing.
    await reader.cancel().catch(() => {});
  }

  if (sessionId && activeSignature && thinking) {
    cacheSignature(sessionId, thinking, activeSignature);
    cacheThinkingFamily(activeSignature, getFamilyName(model));
    if (messageCount !== undefined) {
      cacheSessionSignature(sessionId, activeSignature, messageCount);
    }
    if (assistantTurnIndex !== undefined) {
      cacheSessionReasoning(sessionId, thinking, assistantTurnIndex);
    }
  }

  const content: any[] = [];
  if (thinking) content.push({ type: "thinking", thinking, signature: activeSignature || undefined });
  if (text) content.push({ type: "text", text });
  content.push(...toolUses);

  return {
    id: messageId,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: toolUses.length > 0 ? "tool_use" : stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      ...anthropicCacheUsage(cachedTokens),
    },
  };
}
