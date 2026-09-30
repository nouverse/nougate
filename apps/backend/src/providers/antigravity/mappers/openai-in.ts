import type { IModelSpec } from "@/core/interfaces";
import { getSignature, getSignatureFamily } from "@/providers/antigravity/utils/signature-cache";
import {
  resolveLeadThoughtSignature,
  thoughtSignatureRequired,
} from "@/providers/antigravity/utils/thought-signature";
import { cleanJSONSchemaForAntigravity } from "@/providers/antigravity/utils/schema";
import { getFamilyName } from "@/providers/antigravity/auth/manager";
import { getCavemanPrompt } from "@/core/caveman";
import { UnsupportedContentPartError } from "@/core/upstream-errors";
import { AUDIO_MIME_TYPES, carriesAudio } from "@/providers/antigravity/config/audio";

/**
 * Provider-injected configuration for the OpenAI mapper.
 * The protocol handler passes these from the active provider's config
 * so the mapper stays provider-agnostic.
 */
export interface OpenAIMapperOptions {
  /** Enable aggressive JSON schema cleaning on retry */
  aggressive?: boolean;
  /** Project ID (usually injected by executor, not mapper) */
  projectId?: string;
  /** Optional system instruction prefix to prepend to the user's system prompt */
  systemInstructionPrefix?: string;
  /** Provider feature flags that affect transformation behavior */
  features?: {
    /** Sanitize tool names to match upstream validation rules */
    sanitizeToolNames?: boolean;
    /** Keep thinking blocks even without cached signatures */
    keepThinking?: boolean;
    /** Add Google Search grounding tool to Gemini requests */
    googleSearchGrounding?: boolean;
    /** Grounding mode: 'auto' or 'always' */
    groundingMode?: "auto" | "always";
  };
}

const TOOL_NAME_REMAP_CACHE = new Map<string, string>();

/**
 * Sanitize a function name to match upstream validation rules.
 */
function sanitizeFunctionName(name: string): string {
  if (/^[a-zA-Z_]/.test(name) && /^[a-zA-Z0-9_]+$/.test(name)) {
    return name;
  }

  const cached = TOOL_NAME_REMAP_CACHE.get(name);
  if (cached) {
    return cached;
  }

  let sanitized = name.replace(/[^a-zA-Z0-9_]/g, "_");
  if (/^[0-9]/.test(sanitized)) {
    sanitized = `fn_${sanitized}`;
  }
  if (!sanitized) {
    sanitized = `fn_${Math.random().toString(36).substring(7)}`;
  }

  TOOL_NAME_REMAP_CACHE.set(name, sanitized);
  console.log(`[Sanitize] Renamed tool "${name}" -> "${sanitized}"`);
  return sanitized;
}

/**
 * Look up the original tool name for a sanitized upstream function call.
 */
export function getOriginalToolName(sanitizedName: string): string | undefined {
  for (const [original, sanitized] of TOOL_NAME_REMAP_CACHE) {
    if (sanitized === sanitizedName) {
      return original;
    }
  }

  return undefined;
}

/**
 * Normalize a mixed OpenAI content field into a plain text string.
 */
function getMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter((part: any) => part?.type === "text")
    .map((part: any) => part.text || "")
    .join("\n");
}

/**
 * Resolve the upstream Google model from a provider-local model specification.
 */
function resolveUpstreamModelId(modelSpec: IModelSpec): string {
  return modelSpec.upstreamModelId ?? modelSpec.modelId;
}

/**
 * Build a lookup of tool call IDs to function names from the conversation history.
 */
function buildToolCallNameMap(messages: any[]): Map<string, string> {
  const toolCallNameMap = new Map<string, string>();

  for (const message of messages) {
    if (!message?.tool_calls) {
      continue;
    }

    for (const toolCall of message.tool_calls) {
      if (toolCall.id && toolCall.function?.name) {
        toolCallNameMap.set(toolCall.id, toolCall.function.name);
      }

      if (toolCall.id?.startsWith("sig:")) {
        const idParts = toolCall.id.split(":");
        if (idParts.length >= 3 && toolCall.function?.name) {
          toolCallNameMap.set(idParts.slice(2).join(":"), toolCall.function.name);
        }
      }
    }
  }

  return toolCallNameMap;
}

/**
 * Find the start index of the active user turn for signature-sensitive thinking.
 */
function findCurrentTurnStartIndex(messages: any[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    const hasTextContent =
      typeof message?.content === "string"
        ? message.content.length > 0
        : Array.isArray(message?.content) &&
          message.content.some((part: any) => part?.type === "text");

    if (message?.role === "user" && hasTextContent) {
      return index;
    }
  }

  return 0;
}

/**
 * Strip the "sig:<signature>:" prefix some clients prepend to tool call IDs.
 */
function cleanToolCallId(rawId: unknown): string {
  const id = typeof rawId === "string" ? rawId : "";
  if (!id.startsWith("sig:")) {
    return id;
  }

  const idParts = id.split(":");
  return idParts.length >= 3 ? idParts.slice(2).join(":") : id;
}

/**
 * Convert a tool-role message into Google parts.
 */
function buildToolResponseParts(
  message: any,
  googleModel: string,
  toolCallNameMap: Map<string, string>,
): any[] {
  let responseObject: any;
  try {
    responseObject =
      typeof message.content === "string" ? JSON.parse(message.content) : message.content;
  } catch {
    responseObject = message.content;
  }

  if (
    typeof responseObject !== "object" ||
    responseObject === null ||
    Array.isArray(responseObject)
  ) {
    responseObject = { result: responseObject };
  }

  const functionName =
    message.name || toolCallNameMap.get(message.tool_call_id) || "function_result";
  const functionResponse: any = {
    name: functionName,
    response: responseObject,
  };

  if (googleModel.includes("claude") || googleModel.includes("gemini-3")) {
    functionResponse.id = message.tool_call_id;
  }

  return [{ functionResponse }];
}

/**
 * Refuse `input_audio` this route cannot deliver, before anything else happens to the request.
 *
 * Run up front rather than only where the part is mapped, so the caller gets a 400 even when no
 * account is free — the answer does not depend on one, and a quota error would hide the real cause.
 * An unknown `format` is refused rather than guessed: a wrong MIME type is either a 400 from Google
 * that names a part index, or audio decoded as noise, and neither tells the caller what happened.
 */
export function assertAudioDeliverable(openaiBody: any, modelSpec: IModelSpec): void {
  for (const message of openaiBody?.messages ?? []) {
    if (!Array.isArray(message?.content)) {
      continue;
    }

    for (const part of message.content) {
      if (part?.type !== "input_audio") {
        continue;
      }

      if (!carriesAudio(modelSpec)) {
        throw new UnsupportedContentPartError("input_audio", "antigravity");
      }

      const format = part.input_audio?.format;
      if (!Object.hasOwn(AUDIO_MIME_TYPES, format)) {
        throw new UnsupportedContentPartError(
          `input_audio with format "${String(format)}"`,
          "antigravity",
        );
      }
      if (typeof part.input_audio?.data !== "string" || !part.input_audio.data) {
        throw new UnsupportedContentPartError("input_audio without base64 data", "antigravity");
      }
    }
  }
}

/**
 * Append text, image and audio parts from a regular OpenAI message.
 *
 * Audio arrives here already checked by `assertAudioDeliverable`, so the format is known.
 */
function appendContentParts(parts: any[], message: any): void {
  if (!message?.content) {
    return;
  }

  if (!Array.isArray(message.content)) {
    parts.push({ text: message.content });
    return;
  }

  for (const part of message.content) {
    if (part?.type === "text") {
      parts.push({ text: part.text });
      continue;
    }

    if (part?.type === "image_url" && part.image_url?.url?.startsWith("data:")) {
      const match = part.image_url.url.match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        parts.push({
          inlineData: {
            mimeType: match[1],
            data: match[2],
          },
        });
      }
      continue;
    }

    if (part?.type === "input_audio") {
      parts.push({
        inlineData: {
          mimeType: AUDIO_MIME_TYPES[part.input_audio.format as keyof typeof AUDIO_MIME_TYPES],
          data: part.input_audio.data,
        },
      });
    }
  }
}

/**
 * Append thought parts for the active turn when cached signatures are available.
 */
function appendThoughtParts(parts: any[], message: any, sessionId: string | undefined, keepThinking: boolean, googleModel: string): void {
  const thoughtText = message?.thought || message?.reasoning_content;
  if (!thoughtText) {
    return;
  }

  let signature = sessionId ? getSignature(sessionId, thoughtText) : undefined;
  if (signature) {
    const sigFamily = getSignatureFamily(signature);
    const reqFamily = getFamilyName(googleModel);
    if (sigFamily && sigFamily !== reqFamily) {
      console.log(`[Signature] Skipped signature from different model family: ${sigFamily} vs requested ${reqFamily}`);
      signature = undefined;
    }
  }

  if (signature) {
    parts.push({
      thought: true,
      text: thoughtText,
      thoughtSignature: signature,
      thought_signature: signature,
    });
    return;
  }

  if (keepThinking) {
    parts.push({ thought: true, text: thoughtText });
  }
}

/**
 * Append function call parts from assistant messages.
 *
 * Upstream validates the thought signature on the *first* functionCall part of a
 * model turn and attaches one only to that part, so the leader is the only call
 * that needs a signature — real when cached, placeholder when not.
 */
function appendToolCallParts(params: {
  parts: any[];
  message: any;
  googleModel: string;
  signaturesRequired: boolean;
}): void {
  const { parts, message, googleModel, signaturesRequired } = params;
  const toolCalls = (message?.tool_calls || []).filter((toolCall: any) => toolCall.function);
  if (toolCalls.length === 0) {
    return;
  }

  const leadSignature = resolveLeadThoughtSignature({
    callId: cleanToolCallId(toolCalls[0].id),
    toolName: toolCalls[0].function.name,
    signatureRequired: signaturesRequired,
  });

  for (const [index, toolCall] of toolCalls.entries()) {
    const cleanId = cleanToolCallId(toolCall.id);
    const functionCall: any = {
      name: toolCall.function.name,
      args:
        typeof toolCall.function.arguments === "string"
          ? JSON.parse(toolCall.function.arguments || "{}")
          : toolCall.function.arguments,
    };

    if (googleModel.includes("claude") || googleModel.includes("gemini-3")) {
      functionCall.id = cleanId;
    }

    const functionPart: any = { functionCall };

    if (index === 0 && leadSignature) {
      functionPart.thoughtSignature = leadSignature;
      functionPart.thought_signature = leadSignature;
    }

    parts.push(functionPart);
  }
}

/**
 * Convert a regular user or assistant message into Google parts.
 */
function buildStandardParts(params: {
  message: any;
  googleModel: string;
  isInCurrentTurn: boolean;
  sessionId?: string;
  signaturesRequired: boolean;
  keepThinking: boolean;
}): any[] {
  const { message, googleModel, isInCurrentTurn, sessionId, signaturesRequired, keepThinking } =
    params;
  const parts: any[] = [];

  if (isInCurrentTurn && (message.role === "assistant" || message.role === "model")) {
    appendThoughtParts(parts, message, sessionId, keepThinking, googleModel);
  }

  appendContentParts(parts, message);
  appendToolCallParts({
    parts,
    message,
    googleModel,
    signaturesRequired,
  });

  if (parts.length === 0) {
    parts.push({ text: "." });
  }

  return parts;
}

/**
 * Map OpenAI messages into alternating Google content entries.
 */
function buildGoogleContents(
  messages: any[],
  googleModel: string,
  sessionId: string | undefined,
  keepThinking: boolean,
  isThinking?: boolean,
): any[] {
  const toolCallNameMap = buildToolCallNameMap(messages);
  const currentTurnStartIndex = findCurrentTurnStartIndex(messages);
  // Use modelSpec.isThinking when available; fall back to name-based check for backward compat
  const thinkingEnabled = isThinking ?? googleModel.includes("thinking");
  const signaturesRequired = thoughtSignatureRequired(googleModel, thinkingEnabled);

  const rawContents = messages.map((message, messageIndex) => {
    const isInCurrentTurn = messageIndex >= currentTurnStartIndex;
    const parts =
      message.role === "tool"
        ? buildToolResponseParts(message, googleModel, toolCallNameMap)
        : buildStandardParts({
            message,
            googleModel,
            isInCurrentTurn,
            sessionId,
            signaturesRequired,
            keepThinking,
          });

    return {
      role: message.role === "assistant" || message.role === "model" ? "model" : "user",
      parts,
    };
  });

  const contents: any[] = [];
  for (const entry of rawContents) {
    const previous = contents[contents.length - 1];
    if (!previous || previous.role !== entry.role) {
      contents.push(entry);
      continue;
    }

    const previousHasFunctionParts = previous.parts.some(
      (part: any) => part.functionResponse || part.functionCall,
    );
    const entryHasFunctionParts = entry.parts.some(
      (part: any) => part.functionResponse || part.functionCall,
    );
    const previousHasTextParts = previous.parts.some(
      (part: any) => part.text !== undefined && !part.functionResponse && !part.functionCall,
    );
    const entryHasTextParts = entry.parts.some(
      (part: any) => part.text !== undefined && !part.functionResponse && !part.functionCall,
    );

    const wouldMixTypes =
      (previousHasFunctionParts && entryHasTextParts) ||
      (previousHasTextParts && entryHasFunctionParts);

    if (wouldMixTypes) {
      contents.push({
        role: entry.role === "user" ? "model" : "user",
        parts: [{ text: "." }],
      });
      contents.push(entry);
      continue;
    }

    previous.parts.push(...entry.parts);
  }

  return contents;
}

/**
 * Resolve the optional system instruction block for the upstream request.
 */
function buildSystemInstruction(openaiBody: any, isCliPool: boolean, instructionPrefix?: string): any {
  const systemMessage = (openaiBody.messages || []).find((message: any) => message.role === "system");
  const cavemanPrefix = getCavemanPrompt();

  if (!systemMessage && !cavemanPrefix) {
    return undefined;
  }

  let systemText = systemMessage ? getMessageText(systemMessage.content) : '';
  if (cavemanPrefix) {
    systemText = systemText ? `${cavemanPrefix}\n\n${systemText}` : cavemanPrefix;
  }

  if (!systemText) {
    return undefined;
  }

  if (!isCliPool && instructionPrefix) {
    return {
      role: "user",
      parts: [
        {
          text: `${instructionPrefix}\n\n${systemText}`.trim(),
        },
      ],
    };
  }

  return {
    parts: [{ text: systemText }],
  };
}

/**
 * Resolve the thinking budget from explicit request options or model defaults.
 */
function resolveThinkingBudget(openaiBody: any, modelSpec: IModelSpec): number | undefined {
  const explicitBudget =
    openaiBody.thinking_budget ??
    openaiBody.thinking?.budget_tokens ??
    openaiBody.providerOptions?.thinkingBudget;

  if (explicitBudget !== undefined) {
    return explicitBudget;
  }

  return modelSpec.thinkingBudget;
}

/**
 * Build the tool declaration payload for the Google request.
 */
function buildToolDeclarations(openaiBody: any, aggressive: boolean, sanitizeToolNames: boolean): any[] | undefined {
  if (!openaiBody.tools) {
    return undefined;
  }

  return [
    {
      functionDeclarations: openaiBody.tools.map((tool: any) => {
        const cleanParams = cleanJSONSchemaForAntigravity(
          tool.function.parameters || { type: "object", properties: {} },
          aggressive,
        );

        let functionName = tool.function.name;
        if (sanitizeToolNames) {
          functionName = sanitizeFunctionName(functionName);
        }

        let description = tool.function.description || "";
        const paramNames = Object.keys(cleanParams.properties || {}).filter(
          (key) => key !== "_placeholder",
        );
        if (paramNames.length > 0) {
          description += ` [Parameters: ${paramNames.join(", ")}]`;
        }

        return {
          name: functionName,
          description,
          parameters: cleanParams,
        };
      }),
    },
  ];
}

/**
 * Map an OpenAI-compatible chat completion request into the Google upstream payload.
 */
export function mapOpenAIToGoogle(
  openaiBody: any,
  modelSpec: IModelSpec,
  sessionId?: string,
  options: OpenAIMapperOptions = {},
): any {
  const aggressive = options.aggressive ?? false;
  const features = options.features ?? {};
  const sanitizeToolNames = features.sanitizeToolNames ?? true;
  const keepThinking = features.keepThinking ?? false;
  const googleSearchGrounding = features.googleSearchGrounding ?? false;
  const groundingMode = features.groundingMode ?? "auto";

  assertAudioDeliverable(openaiBody, modelSpec);

  const googleModel = resolveUpstreamModelId(modelSpec);
  const isCliPool = modelSpec.useCliPool ?? modelSpec.pool === "cli";
  const systemMessage = (openaiBody.messages || []).find((message: any) => message.role === "system");
  const otherMessages = (openaiBody.messages || []).filter((message: any) => message.role !== "system");
  const contents = buildGoogleContents(otherMessages, googleModel, sessionId, keepThinking, modelSpec.isThinking);
  const explicitThinkingBudget =
    openaiBody.thinking_budget !== undefined ||
    openaiBody.thinking?.budget_tokens !== undefined ||
    openaiBody.providerOptions?.thinkingBudget !== undefined;
  const isFlashModel = googleModel.includes("flash") && !modelSpec.isThinking;
  const thinkingBudget = resolveThinkingBudget(openaiBody, modelSpec);
  const googleRequest: any = {
    contents,
    systemInstruction: buildSystemInstruction(
      { ...openaiBody, messages: systemMessage ? [systemMessage] : [] },
      isCliPool,
      options.systemInstructionPrefix,
    ),
    generationConfig: {
      temperature: openaiBody.temperature ?? 0.7,
      maxOutputTokens:
        modelSpec.isThinking || explicitThinkingBudget
          ? Math.max(openaiBody.max_tokens || 0, modelSpec.maxOutputTokens)
          : (openaiBody.max_tokens ?? modelSpec.maxOutputTokens),
      topP: openaiBody.top_p ?? 0.95,
      stopSequences: Array.isArray(openaiBody.stop)
        ? openaiBody.stop
        : openaiBody.stop
          ? [openaiBody.stop]
          : undefined,
      candidateCount: 1,
    },
    safetySettings: [
      {
        category: "HARM_CATEGORY_HARASSMENT",
        threshold: process.env.SAFETY_THRESHOLD || "BLOCK_NONE",
      },
      {
        category: "HARM_CATEGORY_HATE_SPEECH",
        threshold: process.env.SAFETY_THRESHOLD || "BLOCK_NONE",
      },
      {
        category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
        threshold: process.env.SAFETY_THRESHOLD || "BLOCK_NONE",
      },
      {
        category: "HARM_CATEGORY_DANGEROUS_CONTENT",
        threshold: process.env.SAFETY_THRESHOLD || "BLOCK_NONE",
      },
    ],
    sessionId: sessionId || crypto.randomUUID(),
  };

  if (modelSpec.isThinking && !isFlashModel) {
    googleRequest.generationConfig.thinkingConfig = {
      includeThoughts: true,
    };

    if (modelSpec.thinkingMode === "level") {
      googleRequest.generationConfig.thinkingConfig.thinkingLevel =
        modelSpec.thinkingLevel || "low";
    } else if (thinkingBudget !== undefined) {
      googleRequest.generationConfig.thinkingConfig.thinkingBudget = thinkingBudget;
    }
  }

  const tools = buildToolDeclarations(openaiBody, aggressive, sanitizeToolNames);
  if (tools) {
    googleRequest.tools = tools;
    if (googleModel.includes("claude")) {
      googleRequest.toolConfig = {
        functionCallingConfig: { mode: "VALIDATED" },
      };
    }
  }

  if (googleModel.includes("gemini") && googleSearchGrounding) {
    const groundingTool: any = { googleSearchRetrieval: {} };
    if (groundingMode === "always") {
      groundingTool.googleSearchRetrieval.dynamicRetrievalConfig = {
        mode: "MODE_UNSPECIFIED",
        dynamicThreshold: 0.0,
      };
    }

    if (!googleRequest.tools) {
      googleRequest.tools = [];
    }
    googleRequest.tools.push(groundingTool);
  }

  return {
    project: options.projectId ?? "",
    model: googleModel,
    userAgent: "antigravity",
    requestId: `agent-${crypto.randomUUID()}`,
    requestType: "agent",
    request: googleRequest,
  };
}
