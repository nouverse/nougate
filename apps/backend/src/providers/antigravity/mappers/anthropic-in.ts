import type { IModelSpec } from "@/core/interfaces";
import { getSignature, getSignatureFamily } from "@/providers/antigravity/utils/signature-cache";
import {
  resolveLeadThoughtSignature,
  thoughtSignatureRequired,
} from "@/providers/antigravity/utils/thought-signature";
import { getCavemanPrompt } from "@/core/caveman";
import { cleanJSONSchemaForAntigravity } from "@/providers/antigravity/utils/schema";
import { getFamilyName } from "@/providers/antigravity/auth/manager";
import { shapeOf, type RequestShape } from "@/providers/antigravity/config/shape";

// ─── Anthropic Request Types ──────────────────────────────────────────────────

export type AnthropicContent =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "tool_use"; id: string; name: string; input: any }
  | { type: "tool_result"; tool_use_id: string; content: string | AnthropicContent[]; is_error?: boolean }
  | { type: "thinking"; thinking: string; signature: string };

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContent[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: any;
}

export interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | AnthropicContent[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stream?: boolean;
  tools?: AnthropicTool[];
  thinking?: { type: "enabled"; budget_tokens: number };
  metadata?: { user_id?: string };
  stop_sequences?: string[];
}

// ─── Mapper Options (provider-agnostic) ─────────────────────────────────────

/**
 * Provider-injected configuration for the mapper.
 * The protocol handler passes these from the active provider's config
 * so the mapper stays provider-agnostic.
 */
export interface AnthropicMapperOptions {
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

// ─── Tool Name Sanitization ──────────────────────────────────────────────────

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

// ─── System Instruction ─────────────────────────────────────────────────────

/**
 * Extract plain text from the Anthropic system field (string or content array).
 */
function extractSystemText(system?: string | AnthropicContent[]): string {
  if (!system) return "";
  if (typeof system === "string") return system;
  return system
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

/**
 * Build the Google system instruction from the Anthropic system field.
 */
function buildSystemInstruction(
  systemText: string,
  isCliPool: boolean,
  instructionPrefix?: string,
): any | undefined {
  if (!systemText && !instructionPrefix) {
    return undefined;
  }

  // Non-CLI pools prepend the provider's system instruction prefix
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

  if (!systemText) {
    return undefined;
  }

  return {
    parts: [{ text: systemText }],
  };
}

// ─── Message Transformation ──────────────────────────────────────────────────

/**
 * Build a lookup of tool_use IDs to function names from the conversation history.
 */
function buildToolUseNameMap(messages: AnthropicMessage[]): Map<string, string> {
  const nameMap = new Map<string, string>();

  for (const message of messages) {
    if (message.role !== "assistant" || typeof message.content === "string") {
      continue;
    }

    for (const block of message.content) {
      if (block.type === "tool_use" && block.id && block.name) {
        nameMap.set(block.id, block.name);
      }
    }
  }

  return nameMap;
}

/**
 * Find the start index of the active user turn for signature-sensitive thinking.
 */
function findCurrentTurnStartIndex(messages: AnthropicMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "user") {
      continue;
    }

    if (typeof message.content === "string" && message.content.length > 0) {
      return index;
    }

    if (
      Array.isArray(message.content) &&
      message.content.some((block) => block.type === "text")
    ) {
      return index;
    }
  }

  return 0;
}

/**
 * Transform a single Anthropic content block into Google parts.
 */
function transformContentBlock(
  block: AnthropicContent,
  googleModel: string,
  shape: RequestShape,
  isInCurrentTurn: boolean,
  sessionId: string | undefined,
  toolUseState: { leadId?: string; leadSignature?: string },
  nameMap: Map<string, string>,
  keepThinking: boolean,
): any[] {
  const parts: any[] = [];

  switch (block.type) {
    case "text": {
      parts.push({ text: block.text });
      break;
    }

    case "image": {
      parts.push({
        inlineData: {
          mimeType: block.source.media_type,
          data: block.source.data,
        },
      });
      break;
    }

    case "tool_use": {
      const functionCall: any = {
        name: block.name,
        args: block.input ?? {},
      };

      if (shape.callIds) {
        functionCall.id = block.id;
      }

      const functionPart: any = { functionCall };

      if (block.id === toolUseState.leadId && toolUseState.leadSignature) {
        functionPart.thoughtSignature = toolUseState.leadSignature;
        functionPart.thought_signature = toolUseState.leadSignature;
      }

      parts.push(functionPart);
      break;
    }

    case "tool_result": {
      const resultContent =
        typeof block.content === "string"
          ? block.content
          : (block.content as AnthropicContent[])
              .filter((c): c is { type: "text"; text: string } => c.type === "text")
              .map((c) => c.text)
              .join("");

      let responseObject: any;
      try {
        responseObject = JSON.parse(resultContent);
      } catch {
        responseObject = resultContent;
      }

      if (
        typeof responseObject !== "object" ||
        responseObject === null ||
        Array.isArray(responseObject)
      ) {
        responseObject = { result: responseObject };
      }

      const functionName = nameMap.get(block.tool_use_id) || "function_result";
      const functionResponse: any = {
        name: functionName,
        response: responseObject,
      };

      if (shape.callIds) {
        functionResponse.id = block.tool_use_id;
      }

      parts.push({ functionResponse });
      break;
    }

    case "thinking": {
      if (isInCurrentTurn) {
        let signature =
          block.signature ||
          (sessionId ? getSignature(sessionId, block.thinking) : undefined);

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
            text: block.thinking,
            thoughtSignature: signature,
            thought_signature: signature,
          });
        } else if (keepThinking) {
          parts.push({ thought: true, text: block.thinking });
        }
      } else if (keepThinking) {
        parts.push({ thought: true, text: block.thinking });
      }
      break;
    }
  }

  return parts;
}

/**
 * Transform a single Anthropic message into a Google content entry.
 */
function transformMessage(
  message: AnthropicMessage,
  googleModel: string,
  shape: RequestShape,
  isInCurrentTurn: boolean,
  sessionId: string | undefined,
  signaturesRequired: boolean,
  nameMap: Map<string, string>,
  keepThinking: boolean,
): { role: string; parts: any[] } {
  const role = message.role === "assistant" ? "model" : "user";
  const parts: any[] = [];

  if (typeof message.content === "string") {
    parts.push({ text: message.content || "." });
    return { role, parts };
  }

  const leadToolUse = message.content.find(
    (block): block is Extract<AnthropicContent, { type: "tool_use" }> => block.type === "tool_use",
  );
  const toolUseState = {
    leadId: leadToolUse?.id,
    leadSignature: leadToolUse
      ? resolveLeadThoughtSignature({
          callId: leadToolUse.id,
          toolName: leadToolUse.name,
          signatureRequired: signaturesRequired,
        })
      : undefined,
  };

  for (const block of message.content) {
    const blockParts = transformContentBlock(
      block,
      googleModel,
      shape,
      isInCurrentTurn,
      sessionId,
      toolUseState,
      nameMap,
      keepThinking,
    );
    parts.push(...blockParts);
  }

  if (parts.length === 0) {
    parts.push({ text: "." });
  }

  return { role, parts };
}

/**
 * Build Google contents array from Anthropic messages with merging of consecutive same-role entries.
 */
function buildGoogleContents(
  messages: AnthropicMessage[],
  googleModel: string,
  shape: RequestShape,
  sessionId: string | undefined,
  keepThinking: boolean,
  isThinking: boolean,
): any[] {
  const nameMap = buildToolUseNameMap(messages);
  const currentTurnStartIndex = findCurrentTurnStartIndex(messages);
  const signaturesRequired = thoughtSignatureRequired(shape, isThinking);

  const rawContents = messages.map((message, messageIndex) => {
    const isInCurrentTurn = messageIndex >= currentTurnStartIndex;
    return transformMessage(
      message,
      googleModel,
      shape,
      isInCurrentTurn,
      sessionId,
      signaturesRequired,
      nameMap,
      keepThinking,
    );
  });

  // Merge consecutive same-role entries, handling mixed function/text parts
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

// ─── Thinking Config ────────────────────────────────────────────────────────

/**
 * Resolve the thinking budget from the Anthropic request body or model defaults.
 */
function resolveThinkingBudget(body: AnthropicRequest, modelSpec: IModelSpec): number | undefined {
  if (body.thinking?.type === "enabled" && body.thinking.budget_tokens !== undefined) {
    return body.thinking.budget_tokens;
  }

  return modelSpec.thinkingBudget;
}

// ─── Tool Declarations ──────────────────────────────────────────────────────

/**
 * Build the tool declaration payload for the Google request from Anthropic tools.
 */
function buildToolDeclarations(
  body: AnthropicRequest,
  aggressive: boolean,
  sanitizeToolNames: boolean,
): any[] | undefined {
  if (!body.tools || body.tools.length === 0) {
    return undefined;
  }

  return [
    {
      functionDeclarations: body.tools.map((tool) => {
        const cleanParams = cleanJSONSchemaForAntigravity(
          tool.input_schema || { type: "object", properties: {} },
          aggressive,
        );

        let functionName = tool.name;
        if (sanitizeToolNames) {
          functionName = sanitizeFunctionName(functionName);
        }

        let description = tool.description || "";
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

// ─── Main Mapper ────────────────────────────────────────────────────────────

/**
 * Map an Anthropic Messages API request into the Google upstream payload.
 *
 * This mapper is **provider-agnostic** — all provider-specific behavior
 * (system instruction prefix, feature flags) is injected via `options`.
 * The protocol handler is responsible for populating these from the active provider.
 *
 * The `project` field is NOT injected here. The executor injects `project: account.projectId`
 * after account selection.
 */
export function mapAnthropicToGoogle(
  body: AnthropicRequest,
  modelSpec: IModelSpec,
  sessionId?: string,
  options: AnthropicMapperOptions = {},
): any {
  const aggressive = options.aggressive ?? false;
  const features = options.features ?? {};
  const sanitizeToolNames = features.sanitizeToolNames ?? true;
  const keepThinking = features.keepThinking ?? false;
  const googleSearchGrounding = features.googleSearchGrounding ?? false;
  const groundingMode = features.groundingMode ?? "auto";

  const googleModel = modelSpec.upstreamModelId ?? modelSpec.modelId;
  const isCliPool = modelSpec.useCliPool ?? modelSpec.pool === "cli";

  const cavemanPrefix = getCavemanPrompt();
  const rawSystemText = extractSystemText(body.system);
  const systemText = cavemanPrefix ? `${cavemanPrefix}\n\n${rawSystemText}` : rawSystemText;
  const shape = shapeOf(modelSpec);
  const contents = buildGoogleContents(body.messages, googleModel, shape, sessionId, keepThinking, modelSpec.isThinking);

  const explicitThinking =
    body.thinking?.type === "enabled" && body.thinking.budget_tokens !== undefined;
  const thinkingBudget = resolveThinkingBudget(body, modelSpec);

  const googleRequest: any = {
    contents,
    systemInstruction: buildSystemInstruction(
      systemText,
      isCliPool,
      options.systemInstructionPrefix,
    ),
    generationConfig: {
      temperature: body.temperature ?? 0.7,
      maxOutputTokens:
        modelSpec.isThinking || explicitThinking
          ? Math.max(body.max_tokens || 0, modelSpec.maxOutputTokens)
          : (body.max_tokens ?? modelSpec.maxOutputTokens),
      topP: body.top_p ?? 0.95,
      stopSequences: body.stop_sequences,
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

  // Apply thinking config based on IModelSpec
  if (modelSpec.isThinking) {
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

  // Apply tool declarations
  const tools = buildToolDeclarations(body, aggressive, sanitizeToolNames);
  if (tools) {
    googleRequest.tools = tools;
    if (shape.validatedTools) {
      googleRequest.toolConfig = {
        functionCallingConfig: { mode: "VALIDATED" },
      };
    }
  }

  // Google Search grounding (Gemini models only)
  if (shape.grounding && googleSearchGrounding) {
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
