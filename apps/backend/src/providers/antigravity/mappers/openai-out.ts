import {
  cacheSignature,
  cacheSignatureByCallId,
  cacheSessionSignature,
  cacheThinkingFamily,
  cacheSessionReasoning,
} from "../utils/signature-cache";
import { getFamilyName } from "../auth/manager";
import { getOriginalToolName } from "./openai-in";

/**
 * Transform a single Google SSE event into the OpenAI chunk format.
 */
export function transformGoogleEventToOpenAI(
  googleData: any,
  model: string,
  requestId?: string,
  hasPriorToolCalls: boolean = false,
  activeSignature?: string,
): any {
  const data = googleData.response || googleData;
  const requestIdActual = requestId || `chatcmpl-${Math.random().toString(36).substring(7)}`;
  const usage = data.usageMetadata
    ? {
        prompt_tokens: data.usageMetadata.promptTokenCount || 0,
        completion_tokens: data.usageMetadata.candidatesTokenCount || 0,
        total_tokens: data.usageMetadata.totalTokenCount || 0,
      }
    : undefined;

  if (!data.candidates || data.candidates.length === 0) {
    if (!usage) {
      return null;
    }

    return {
      id: requestIdActual,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [],
      usage,
    };
  }

  const candidate = data.candidates[0];
  const parts = candidate.content?.parts || [];
  const finishReason = candidate.finishReason;
  if (parts.length === 0 && !finishReason && !usage) {
    return null;
  }

  const delta: any = {};
  const toolCalls: any[] = [];
  let extractedSignature: string | undefined;
  let extractedThought: string | undefined;

  for (const part of parts) {
    const isThought = part.thought || part.thoughtText || part.type === "thinking";

    if (part.text) {
      let cleanText = part.text;
      if (cleanText.includes("thoughtSignature:")) {
        cleanText = cleanText.replace(/thoughtSignature:[a-zA-Z0-9\-_]+/g, "").trim();
      }

      if (cleanText) {
        if (isThought) {
          delta.reasoning_content = (delta.reasoning_content || "") + cleanText;
          extractedThought = (extractedThought || "") + cleanText;
        } else {
          delta.content = (delta.content || "") + cleanText;
        }
      }
    }

    if (isThought && typeof isThought === "string") {
      delta.reasoning_content = (delta.reasoning_content || "") + isThought;
      extractedThought = (extractedThought || "") + isThought;
    }

    if (part.thoughtSignature || part.thought_signature || part.signature) {
      extractedSignature =
        part.thoughtSignature || part.thought_signature || part.signature;
    }

    if (part.functionCall || part.function_call) {
      const call = part.functionCall || part.function_call;
      const signature =
        part.thoughtSignature || part.thought_signature || extractedSignature || activeSignature || "";
      const rawId =
        call.id || call.callId || call.call_id || `call_${Math.random().toString(36).substring(7)}`;

      if (signature) {
        cacheSignatureByCallId(rawId, signature);
      }

      const functionName = getOriginalToolName(call.name) || call.name;
      toolCalls.push({
        index: toolCalls.length,
        id: rawId,
        type: "function",
        function: {
          name: functionName,
          arguments: typeof call.args === "string" ? call.args : JSON.stringify(call.args || {}),
        },
      });

      if (signature) {
        extractedSignature = signature;
      }
    }
  }

  if (toolCalls.length > 0) {
    delta.tool_calls = toolCalls;
  }

  let openAIFinishReason: string | null = null;
  if (finishReason) {
    if (toolCalls.length > 0 || hasPriorToolCalls) {
      openAIFinishReason = "tool_calls";
    } else if (finishReason === "STOP") {
      openAIFinishReason = "stop";
    } else if (finishReason === "MAX_TOKENS") {
      openAIFinishReason = "length";
    } else if (finishReason === "SAFETY") {
      openAIFinishReason = "content_filter";
    } else if (finishReason === "MALFORMED_FUNCTION_CALL") {
      openAIFinishReason = "tool_calls";
    } else {
      openAIFinishReason = "stop";
    }
  }

  return {
    id: requestIdActual,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: openAIFinishReason,
      },
    ],
    usage,
    _signature: extractedSignature,
    _thought: extractedThought,
  };
}

/**
 * Convert the Google SSE stream into an OpenAI-compatible SSE stream.
 */
export function createOpenAIStreamTransformer(
  model: string,
  requestId: string,
  hasPriorToolCalls: boolean,
  sessionId?: string,
  messageCount?: number,
  assistantTurnIndex?: number,
) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let currentHasPriorToolCalls = hasPriorToolCalls;
  let activeSignature: string | undefined;

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine || !trimmedLine.startsWith("data: ")) {
          continue;
        }

        const dataString = trimmedLine.slice(6);
        if (dataString === "[DONE]") {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          continue;
        }

        try {
          const googleEvent = JSON.parse(dataString);
          const openAIEvent = transformGoogleEventToOpenAI(
            googleEvent,
            model,
            requestId,
            currentHasPriorToolCalls,
            activeSignature,
          );

          if (!openAIEvent) {
            continue;
          }

          if (openAIEvent._signature) {
            activeSignature = openAIEvent._signature;
          }

          if (sessionId && openAIEvent._signature && openAIEvent._thought) {
            cacheSignature(sessionId, openAIEvent._thought, openAIEvent._signature);
            cacheThinkingFamily(openAIEvent._signature, getFamilyName(model));
            if (messageCount !== undefined) {
              cacheSessionSignature(sessionId, openAIEvent._signature, messageCount);
            }
            if (assistantTurnIndex !== undefined) {
              cacheSessionReasoning(sessionId, openAIEvent._thought, assistantTurnIndex);
            }
            console.log(`[Cache] Signature cached for conversation ${sessionId}`);
          }

          const choice = openAIEvent.choices?.[0];
          const delta = choice?.delta;
          const hasMeaningfulContent =
            (delta && (delta.content || delta.reasoning_content || delta.tool_calls)) ||
            (choice && choice.finish_reason) ||
            openAIEvent.usage;

          if (!hasMeaningfulContent) {
            continue;
          }

          if (delta?.tool_calls) {
            currentHasPriorToolCalls = true;
          }

          const { _signature, _thought, ...cleanEvent } = openAIEvent;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(cleanEvent)}\n\n`));
        } catch (error) {
          console.warn("[Stream] Failed to parse SSE line:", error);
        }
      }
    },
    flush(controller) {
      if (!buffer.trim().startsWith("data: ")) {
        return;
      }

      const dataString = buffer.trim().slice(6);
      if (dataString === "[DONE]") {
        return;
      }

      try {
        const googleEvent = JSON.parse(dataString);
        const openAIEvent = transformGoogleEventToOpenAI(
          googleEvent,
          model,
          requestId,
          currentHasPriorToolCalls,
          activeSignature,
        );

        if (!openAIEvent) {
          return;
        }

        const { _signature, _thought, ...cleanEvent } = openAIEvent;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(cleanEvent)}\n\n`));
      } catch (error) {
        console.warn("[Stream] Failed to parse final line in flush:", error);
      }
    },
  });
}
