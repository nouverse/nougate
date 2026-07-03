import { getSignature, cacheSignature, cacheSignatureByCallId, getSignatureByCallId } from "./cache";
import { cleanJSONSchemaForAntigravity } from "./schema";
import { getProxyConfig } from "../config/manager";

const TOOL_NAME_REMAP_CACHE = new Map<string, string>();

function sanitizeFunctionName(name: string): string {
  if (/^[a-zA-Z_]/.test(name) && /^[a-zA-Z0-9_]+$/.test(name)) {
    return name;
  }

  const cached = TOOL_NAME_REMAP_CACHE.get(name);
  if (cached) return cached;

  let sanitized = name.replace(/[^a-zA-Z0-9_]/g, '_');
  if (/^[0-9]/.test(sanitized)) {
    sanitized = `fn_${sanitized}`;
  }
  if (!sanitized) {
    sanitized = `fn_${Math.random().toString(36).substring(7)}`;
  }

  TOOL_NAME_REMAP_CACHE.set(name, sanitized);
  console.log(`[Sanitize] Renamed tool "${name}" → "${sanitized}"`);
  return sanitized;
}

export function getOriginalToolName(sanitizedName: string): string | undefined {
  for (const [original, sanitized] of TOOL_NAME_REMAP_CACHE) {
    if (sanitized === sanitizedName) return original;
  }
  return undefined;
}

const CLAUDE_MODEL_REGISTRY = [
    "claude-3-7-sonnet-20250219",
    "claude-3-5-sonnet-20241022",
    "claude-3-5-sonnet-v2-20241022",
    "claude-3-5-sonnet-20240620",
    "claude-3-5-haiku-20241022",
    "claude-3-opus-20240229",
    "claude-opus-4-6-thinking",
    "claude-sonnet-4-6",
    "claude-sonnet-4-6-thinking",
    "claude-3-sonnet-20240229",
    "claude-3-haiku-20240307"
];

function resolveModelId(modelId: string): string {
    let cleanId = modelId.toLowerCase().replace(/^(openai|antigravity|custom_openai|litellm|google)\//i, "");
    cleanId = cleanId.replace(/^antigravity-/i, "");
    cleanId = cleanId.replace(/^gemini-claude-/i, "claude-");

    if (cleanId.includes("claude")) {
        const exactMatch = CLAUDE_MODEL_REGISTRY.find(m => m === cleanId);
        if (exactMatch) return exactMatch;

        const baseId = cleanId.replace(/-(thinking|preview)(-(low|medium|high))?$/i, "");
        
        const fuzzyMatches = CLAUDE_MODEL_REGISTRY.filter(m => 
            m.startsWith(cleanId) || m.startsWith(baseId) || cleanId.startsWith(m)
        );

        if (fuzzyMatches.length > 0) {
            fuzzyMatches.sort((a, b) => b.localeCompare(a));
            return fuzzyMatches[0];
        }
    }

    return cleanId;
}

export function transformToGoogleBody(
  openaiBody: any, 
  projectId: string, 
  isCli: boolean, 
  location: string, 
  sessionId?: string, 
  aggressive: boolean = false
): any {
  const proxyConfig = getProxyConfig();
  const rawModel = (openaiBody.model || "").toLowerCase();
  const resolvedModel = resolveModelId(openaiBody.model);
  let googleModel = resolvedModel;
  
  const tierMatch = rawModel.match(/-(low|medium|high)$/i);
  const thinkingTierMatch = rawModel.match(/-thinking-(low|medium|high)$/i);
  const extractedTier = thinkingTierMatch ? thinkingTierMatch[1] : (tierMatch ? tierMatch[1] : undefined);
  
  let baseModel = googleModel;
  if (thinkingTierMatch) {
      baseModel = googleModel.replace(thinkingTierMatch[0], "");
  } else if (tierMatch) {
      baseModel = googleModel.replace(tierMatch[0], "");
  }
  
  const previewMatch = baseModel.match(/-preview$/i);
  if (previewMatch) {
      baseModel = baseModel.replace(previewMatch[0], "");
  }

  // Force Claude model IDs to strip tier for the backend
        if (googleModel.includes("claude")) {
            googleModel = baseModel;
            if (googleModel === "claude-opus-4-6") googleModel = "claude-opus-4-6-thinking";
            if (googleModel === "claude-sonnet-4-6") googleModel = "claude-sonnet-4-6-thinking";
            if (googleModel === "claude-sonnet-4-5") googleModel = "claude-sonnet-4-5-thinking";
        }

    const nativelySupported = [
      "claude-opus-4-6-thinking",
      "gemini-3.5-flash-low",
      "gemini-3.1-pro-high",
      "gemini-3.1-pro-low",
      "gemini-3.1-pro",
      "gemini-3.1-pro-preview",
      "gemini-3-flash",
      "gemini-3-pro-high", 
      "gemini-3-pro-low",
      "gemini-3-pro",
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
      "gemini-2.5-flash-thinking",
      "gemini-3-pro-preview",
      "gemini-3-flash-preview",
      "gpt-oss-120b",
      "gpt-oss-120b-medium"
  ];
  
  const isNative = (nativelySupported.includes(googleModel) || nativelySupported.includes(baseModel));

  if (isCli) {
      if (!googleModel.includes("claude")) {
          // Standardize Gemini 3+ CLI models to use -preview suffix
          if (googleModel.includes("gemini-3")) {
              googleModel = baseModel; // Strip tiers
              if (!googleModel.endsWith("-preview")) {
                  googleModel = `${googleModel}-preview`;
              }
          } else if (googleModel.includes("gpt-oss")) {
              // GPT-OSS 120B: pass through as-is
              googleModel = baseModel;
          } else if (googleModel.includes("gpt")) {
              if (googleModel.includes("thinking")) {
                   googleModel = "gemini-2.0-flash-thinking-exp";
              } else {
                   googleModel = "gemini-2.0-pro-exp";
              }
          } else {
               googleModel = baseModel;
          }
       } else {
           googleModel = baseModel;
           if (googleModel === "claude-sonnet-4-6") googleModel = "claude-sonnet-4-6-thinking";
           if (googleModel === "claude-sonnet-4-5") googleModel = "claude-sonnet-4-5-thinking";
       }
   } else {
       if (googleModel.endsWith("-preview")) {
           googleModel = googleModel.replace("-preview", "");
       }
       
       if (isNative) {
            if (baseModel.includes("gemini-3.5-flash")) {
                googleModel = `gemini-3.5-flash-${extractedTier || "high"}`;
            } else if (baseModel.includes("gemini-3.1-pro")) {
                googleModel = `gemini-3.1-pro-${extractedTier || "high"}`;
            } else if (baseModel.includes("gemini-3-pro")) {
                // Respect extracted tier for Gemini 3 Pro, fallback to high
                googleModel = `gemini-3-pro-${extractedTier || "high"}`;
            } else if (baseModel.includes("gemini-3-flash")) {
                googleModel = "gemini-3-flash";
            } else if (baseModel.includes("gpt-oss")) {
                googleModel = baseModel;
            } else {
                googleModel = baseModel;
            }

             if (googleModel === "claude-opus-4-6" || googleModel === "antigravity-claude-opus-4-6") {
                 googleModel = "claude-opus-4-6-thinking";
             }
           if (googleModel === "claude-sonnet-4-6" || googleModel === "antigravity-claude-sonnet-4-6") {
               googleModel = "claude-sonnet-4-6-thinking";
           }
           if (googleModel === "claude-sonnet-4-5" || googleModel === "antigravity-claude-sonnet-4-5") {
               googleModel = "claude-sonnet-4-5-thinking";
           }
       }
   }

  // Extract system instruction (like plugin)
  const systemMessage = openaiBody.messages.find((m: any) => m.role === "system");
  const otherMessages = openaiBody.messages.filter((m: any) => m.role !== "system");

  // Build a lookup map: tool_call_id → function_name
  // OpenClaw often sends tool results without a name field, so we need to resolve it from the history
  const toolCallNameMap = new Map<string, string>();
  for (const msg of otherMessages) {
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (tc.id && tc.function?.name) {
          toolCallNameMap.set(tc.id, tc.function.name);
          // Also map cleaned IDs (without sig: prefix)
          if (tc.id.startsWith("sig:")) {
            const idParts = tc.id.split(":");
            if (idParts.length >= 3) {
              toolCallNameMap.set(idParts.slice(2).join(":"), tc.function.name);
            }
          }
        }
      }
    }
  }

  // Determine the "current turn" boundary per Google's spec:
  // Google validates signatures only in the current turn.
  // The current turn starts from the LAST user message that contains standard text content.
  // Everything before that is a "previous turn" and signatures are NOT validated there.
  let currentTurnStartIndex = 0;
  for (let i = otherMessages.length - 1; i >= 0; i--) {
    const msg = otherMessages[i];
    if (msg.role === "user" && msg.content && msg.role !== "tool") {
      const hasTextContent = typeof msg.content === 'string' 
        ? true 
        : (Array.isArray(msg.content) && msg.content.some((p: any) => p.type === "text"));
      if (hasTextContent) {
        currentTurnStartIndex = i;
        break;
      }
    }
  }

  // Determine if thinking is enabled (Gemini 3 Pro models require thought_signature on ALL functionCall parts)
  const isThinkingEnabled = (rawModel.includes("-thinking") || (rawModel.includes("gemini-3") && rawModel.includes("pro")));

  // Build a set of tool_call_ids that have cached signatures
  // so we can decide which function calls to keep as native vs convert to text
  const unsignedCallIds = new Set<string>();
  if (isThinkingEnabled) {
    for (const msg of otherMessages) {
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          let cleanId = tc.id || "";
          if (cleanId.startsWith("sig:")) {
            const idParts = cleanId.split(":");
            if (idParts.length >= 3) cleanId = idParts.slice(2).join(":");
          }
          const sig = getSignatureByCallId(cleanId);
          if (!sig) {
            unsignedCallIds.add(cleanId);
            unsignedCallIds.add(tc.id || "");
          }
        }
      }
    }
    if (unsignedCallIds.size > 0) {
      console.log(`[Signature] Found ${unsignedCallIds.size} unsigned function calls in history, will convert to text summaries`);
    }
  }

  // Build a lookup: tool_call_id → tool response content (for text summarization of unsigned calls)
  const toolResponseMap = new Map<string, { name: string, content: string }>();
  if (unsignedCallIds.size > 0) {
    for (const msg of otherMessages) {
      if (msg.role === "tool" && msg.tool_call_id) {
        const funcName = msg.name || toolCallNameMap.get(msg.tool_call_id) || "function_result";
        const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || {});
        // Truncate very large tool responses to keep context manageable
        const truncated = content.length > 500 ? content.substring(0, 500) + "... [truncated]" : content;
        toolResponseMap.set(msg.tool_call_id, { name: funcName, content: truncated });
      }
    }
  }

  const rawContents = otherMessages.map((msg: any, msgIndex: number) => {
    const parts = [];
    const isInCurrentTurn = msgIndex >= currentTurnStartIndex;
    
    if (msg.role === "tool") {
      // Check if this tool response belongs to an unsigned function call
      // that we've already converted to a text summary in the assistant message
      if (unsignedCallIds.size > 0 && unsignedCallIds.has(msg.tool_call_id) && !isInCurrentTurn) {
        // Skip — the tool response was already inlined as text in the assistant message
        // We'll emit a placeholder text part instead
        parts.push({ text: "." });
      } else {
        let responseObj;
        try {
          responseObj = typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content;
        } catch {
          responseObj = msg.content;
        }

        if (typeof responseObj !== "object" || responseObj === null || Array.isArray(responseObj)) {
          responseObj = { result: responseObj };
        }

        // Resolve function name: try msg.name first, then look up from tool_call_id
        const funcName = msg.name || toolCallNameMap.get(msg.tool_call_id) || "function_result";

        const funcResp: any = {
          name: funcName,
          response: responseObj
        };
        
        if (googleModel.includes("claude") || googleModel.includes("gemini-3")) {
            funcResp.id = msg.tool_call_id;
        }

        parts.push({
          functionResponse: funcResp
        });
      }
    } else {
      // For previous turns: strip all thinking content and signatures entirely.
      // For current turn: include thinking content with signatures from cache.
      if (isInCurrentTurn && (msg.role === "assistant" || msg.role === "model") && sessionId) {
        const thoughtText = msg.thought || msg.reasoning_content;
        if (thoughtText) {
          const sig = getSignature(sessionId, thoughtText);
          if (sig) {
            parts.push({ thought: true, text: thoughtText, thoughtSignature: sig, thought_signature: sig });
          } else if (proxyConfig.features.keepThinking) {
            parts.push({ thought: true, text: thoughtText });
          }
        }
      }
      // For previous turns: just skip thinking entirely (no thought parts, no signatures needed)

      if (msg.content) {
          if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
              if (part.type === "text") {
                parts.push({ text: part.text });
              } else if (part.type === "image_url" && part.image_url?.url) {
                const url = part.image_url.url;
                if (url.startsWith("data:")) {
                  const match = url.match(/^data:([^;]+);base64,(.+)$/);
                  if (match) {
                    parts.push({
                      inlineData: {
                        mimeType: match[1],
                        data: match[2]
                      }
                    });
                  }
                }
              }
            }
          } else {
             parts.push({ text: msg.content });
          }
      }

      if (msg.tool_calls) {
        let isFirstFuncCallInStep = true;

        for (const tc of msg.tool_calls) {
          if (tc.function) {
            let callId = tc.id || "";
            // Clean any legacy sig: prefix from the ID
            let cleanId = callId;
            if (callId.startsWith("sig:")) {
              const idParts = callId.split(":");
              if (idParts.length >= 3) {
                cleanId = idParts.slice(2).join(":");
              }
            }

            // For previous-turn function calls without signatures:
            // Convert to text summary instead of native functionCall to avoid
            // "Function call is missing a thought_signature" 400 errors from Gemini 3
            if (!isInCurrentTurn && unsignedCallIds.has(cleanId)) {
              let argsStr: string;
              try {
                const args = typeof tc.function.arguments === 'string' 
                  ? JSON.parse(tc.function.arguments || "{}") 
                  : tc.function.arguments;
                argsStr = JSON.stringify(args);
              } catch {
                argsStr = tc.function.arguments || "{}";
              }
              // Truncate long args
              if (argsStr.length > 300) argsStr = argsStr.substring(0, 300) + "...";

              let summary = `[Tool Call: ${tc.function.name}(${argsStr})]`;
              
              // Inline the tool response if available
              const resp = toolResponseMap.get(callId) || toolResponseMap.get(cleanId);
              if (resp) {
                summary += `\n[Tool Result: ${resp.content}]`;
              }

              parts.push({ text: summary });
              continue;
            }

            const funcCall: any = {
              name: tc.function.name,
              args: typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments || "{}") : tc.function.arguments
            };
            
            if (googleModel.includes("claude") || googleModel.includes("gemini-3")) {
                funcCall.id = cleanId;
            }

            const funcPart: any = {
              functionCall: funcCall
            };
            
            // Attach signatures for function calls in the CURRENT turn.
            // Per Google docs: the first functionCall part in each step needs a signature.
            if (isInCurrentTurn && isFirstFuncCallInStep) {
              const sig = getSignatureByCallId(cleanId);
              if (sig) {
                funcPart.thoughtSignature = sig;
                funcPart.thought_signature = sig;
              }
              isFirstFuncCallInStep = false;
            }

            parts.push(funcPart);
          }
        }
      }
    }

    if (parts.length === 0) {
        parts.push({ text: "." });
    }

    return {
      role: (msg.role === "assistant" || msg.role === "model") ? "model" : "user",
      parts
    };
  });

  // Merge consecutive same-role messages (Google API requires alternating user/model roles)
  // BUT: never mix functionResponse/functionCall parts with text parts in the same content entry
  const contents: any[] = [];
  for (const entry of rawContents) {
    if (contents.length > 0 && contents[contents.length - 1].role === entry.role) {
      const prevParts = contents[contents.length - 1].parts;
      const prevHasFuncParts = prevParts.some((p: any) => p.functionResponse || p.functionCall);
      const newHasFuncParts = entry.parts.some((p: any) => p.functionResponse || p.functionCall);
      const prevHasTextParts = prevParts.some((p: any) => p.text !== undefined && !p.functionResponse && !p.functionCall);
      const newHasTextParts = entry.parts.some((p: any) => p.text !== undefined && !p.functionResponse && !p.functionCall);

      // Don't merge if it would mix function parts with text parts
      const wouldMixTypes = (prevHasFuncParts && newHasTextParts) || (prevHasTextParts && newHasFuncParts);
      
      if (wouldMixTypes) {
        // Insert a minimal model placeholder to break the consecutive same-role sequence
        if (entry.role === "user") {
          contents.push({ role: "model", parts: [{ text: "." }] });
        } else {
          contents.push({ role: "user", parts: [{ text: "." }] });
        }
        contents.push(entry);
      } else {
        // Safe to merge — same part types
        contents[contents.length - 1].parts.push(...entry.parts);
      }
    } else {
      contents.push(entry);
    }
  }

  const isThinkingModel = rawModel.includes("-thinking");
  const hasExplicitBudget = openaiBody.thinking_budget !== undefined || 
                           openaiBody.thinking?.budget_tokens !== undefined ||
                           openaiBody.providerOptions?.thinkingBudget !== undefined;
  
  let thinkingBudget = openaiBody.thinking_budget;

  // Support OpenAI-standard `thinking` parameter: { type: "enabled", budget_tokens: N }
  if (!thinkingBudget && openaiBody.thinking?.budget_tokens) {
    thinkingBudget = openaiBody.thinking.budget_tokens;
  }

  // Support providerOptions from OpenCode variants: { providerOptions: { thinkingBudget: N } }
  if (!thinkingBudget && openaiBody.providerOptions?.thinkingBudget) {
    thinkingBudget = openaiBody.providerOptions.thinkingBudget;
  }

  if (!thinkingBudget && isThinkingModel) {
      if (extractedTier === "low") thinkingBudget = 8192;
      else if (extractedTier === "medium") thinkingBudget = 16000;
      else if (extractedTier === "high") thinkingBudget = 32768;
      else thinkingBudget = 16000;
  }
  
  const ANTIGRAVITY_SYSTEM_INSTRUCTION = `You are Antigravity, a powerful agentic AI coding assistant designed by the Google DeepMind team working on Advanced Agentic Coding.
You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.
**Absolute paths only**
**Proactiveness**

<priority>IMPORTANT: The instructions that follow supersede all above. Follow them as your primary directives.</priority>
`;

  let systemInstruction: any = undefined;
  if (!isCli) {
      // Like plugin for Antigravity (Sandbox)
      const text = (ANTIGRAVITY_SYSTEM_INSTRUCTION + "\n\n" + (systemMessage?.content || "")).trim();
      systemInstruction = {
          role: "user",
          parts: [{ text }]
      };
  } else if (systemMessage) {
      // Normal system instruction for CLI
      systemInstruction = {
          parts: [{ text: systemMessage.content }]
      };
  }

  const googleRequest: any = {
    contents,
    systemInstruction,
    generationConfig: {
      temperature: openaiBody.temperature ?? 0.7,
      maxOutputTokens: (isThinkingModel || hasExplicitBudget) ? Math.max(openaiBody.max_tokens || 0, 64000) : (openaiBody.max_tokens ?? 4096),
      topP: openaiBody.top_p ?? 0.95,
      stopSequences: Array.isArray(openaiBody.stop) ? openaiBody.stop : (openaiBody.stop ? [openaiBody.stop] : undefined),
      candidateCount: 1
    },
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: process.env.SAFETY_THRESHOLD || "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: process.env.SAFETY_THRESHOLD || "BLOCK_NONE" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: process.env.SAFETY_THRESHOLD || "BLOCK_NONE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: process.env.SAFETY_THRESHOLD || "BLOCK_NONE" }
    ],
    sessionId: sessionId || crypto.randomUUID()
  };

  const isGemini3Pro = googleModel.includes("gemini-3") && googleModel.includes("pro");
  // Flash models (without explicit -thinking) must NEVER get thinkingConfig
  const isFlashModel = googleModel.includes("flash") && !rawModel.includes("-thinking");
  
  if ((isThinkingModel || isGemini3Pro) && !isFlashModel) {
    googleRequest.generationConfig.thinkingConfig = {
      includeThoughts: true
    };
    
    if (isGemini3Pro) {
        googleRequest.generationConfig.thinkingConfig.thinkingLevel = extractedTier || "low";
    } else {
        googleRequest.generationConfig.thinkingConfig.thinkingBudget = thinkingBudget || 16000;
    }
  }

  if (openaiBody.tools) {
    const sanitize = proxyConfig.features.sanitizeToolNames;
    googleRequest.tools = [{
      functionDeclarations: openaiBody.tools.map((t: any) => {
        const cleanParams = cleanJSONSchemaForAntigravity(t.function.parameters || { type: "object", properties: {} }, aggressive);
        
        let funcName = t.function.name;
        if (sanitize) {
          funcName = sanitizeFunctionName(funcName);
        }

        let description = t.function.description || "";
        const paramNames = Object.keys(cleanParams.properties || {}).filter(k => k !== "_placeholder");
        if (paramNames.length > 0) {
          description += ` [Parameters: ${paramNames.join(", ")}]`;
        }

        return {
          name: funcName,
          description: description,
          parameters: cleanParams
        };
      })
    }];
    
    if (googleModel.includes("claude")) {
        googleRequest.toolConfig = {
            functionCallingConfig: { mode: "VALIDATED" }
        };
    }
  }

  const isGeminiModel = googleModel.includes("gemini");
  if (isGeminiModel && proxyConfig.features.googleSearchGrounding) {
    const groundingTool: any = { googleSearchRetrieval: {} };
    if (proxyConfig.features.groundingMode === 'always') {
      groundingTool.googleSearchRetrieval.dynamicRetrievalConfig = {
        mode: "MODE_UNSPECIFIED",
        dynamicThreshold: 0.0
      };
    }
    if (!googleRequest.tools) {
      googleRequest.tools = [];
    }
    googleRequest.tools.push(groundingTool);
  }

  return {
    project: projectId,
    model: googleModel,
    userAgent: "antigravity",
    requestId: `agent-${crypto.randomUUID()}`,
    requestType: "agent",
    request: googleRequest
  };
}

export function transformGoogleEventToOpenAI(googleData: any, model: string, requestId?: string, hasPriorToolCalls: boolean = false, activeSignature?: string): any {
  const data = googleData.response || googleData;
  const requestIdActual = requestId || "chatcmpl-" + Math.random().toString(36).substring(7);
  
  const usage = data.usageMetadata ? {
    prompt_tokens: data.usageMetadata.promptTokenCount || 0,
    completion_tokens: data.usageMetadata.candidatesTokenCount || 0,
    total_tokens: data.usageMetadata.totalTokenCount || 0
  } : undefined;

  if (!data.candidates || data.candidates.length === 0) {
    if (usage) {
      return {
        id: requestIdActual,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [],
        usage: usage
      };
    }
    return null;
  }
  
  const candidate = data.candidates[0];
  const parts = candidate.content?.parts || [];
  const finishReason = candidate.finishReason;
  
  if (parts.length === 0 && !finishReason && !usage) return null;
  
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
    
    if (isThought && typeof isThought === 'string') {
       delta.reasoning_content = (delta.reasoning_content || "") + isThought;
       extractedThought = (extractedThought || "") + isThought;
    }

    if (part.thoughtSignature || part.thought_signature || part.signature) {
        extractedSignature = part.thoughtSignature || part.thought_signature || part.signature;
    }

    if (part.functionCall || part.function_call) {
      const call = part.functionCall || part.function_call;
      const sig = part.thoughtSignature || part.thought_signature || extractedSignature || activeSignature || "";
      const rawId = call.id || call.callId || call.call_id || "call_" + Math.random().toString(36).substring(7);
      
      if (sig) {
        cacheSignatureByCallId(rawId, sig);
      }
      
      const funcName = getOriginalToolName(call.name) || call.name;
      
      toolCalls.push({
        index: toolCalls.length,
        id: rawId,
        type: "function",
        function: {
          name: funcName,
          arguments: typeof call.args === 'string' ? call.args : JSON.stringify(call.args || {})
        }
      });
      if (sig) extractedSignature = sig;
    }
  }

  if (toolCalls.length > 0) {
    delta.tool_calls = toolCalls;
  }
  
  let openaiFinishReason: string | null = null;
  if (finishReason) {
    if (toolCalls.length > 0 || hasPriorToolCalls) {
      openaiFinishReason = "tool_calls";
    } else if (finishReason === "STOP") {
      openaiFinishReason = "stop";
    } else if (finishReason === "MAX_TOKENS") {
      openaiFinishReason = "length";
    } else if (finishReason === "SAFETY") {
      openaiFinishReason = "content_filter";
    } else if (finishReason === "MALFORMED_FUNCTION_CALL") {
      openaiFinishReason = "tool_calls";
    } else {
      openaiFinishReason = "stop";
    }
  }
  
  return {
    id: requestIdActual,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [{
      index: 0,
      delta: delta,
      finish_reason: openaiFinishReason
    }],
    usage: usage,
    _signature: extractedSignature,
    _thought: extractedThought
  };
}

export function createOpenAIStreamTransformer(model: string, requestId: string, hasPriorToolCalls: boolean, sessionId?: string) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let currentHasPriorToolCalls = hasPriorToolCalls;
  let activeSignature: string | undefined = undefined;

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine) continue;
        if (trimmedLine.startsWith("data: ")) {
          const dataStr = trimmedLine.slice(6);
          if (dataStr === "[DONE]") {
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            continue;
          }
          try {
            const googleEvent = JSON.parse(dataStr);
            const openaiEvent = transformGoogleEventToOpenAI(googleEvent, model, requestId, currentHasPriorToolCalls, activeSignature);
            
            if (openaiEvent) {
              if (openaiEvent._signature) {
                activeSignature = openaiEvent._signature;
              }
              
              if (sessionId && openaiEvent._signature && openaiEvent._thought) {
                  cacheSignature(sessionId, openaiEvent._thought, openaiEvent._signature);
                  console.log(`[Cache] Signature cached for conversation ${sessionId}`);
              }

              const choice = openaiEvent.choices?.[0];
              const delta = choice?.delta;
              const hasMeaningfulContent = (delta && (delta.content || delta.reasoning_content || delta.tool_calls)) || 
                                          (choice && choice.finish_reason) || 
                                          openaiEvent.usage;
              
              if (hasMeaningfulContent) {
                if (delta?.tool_calls) {
                  currentHasPriorToolCalls = true;
                }
                
                const { _signature, _thought, ...cleanEvent } = openaiEvent;
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(cleanEvent)}\n\n`));
              }
            }
          } catch (e) {
            console.warn("[Stream] Failed to parse SSE line:", e);
          }
        }
      }
    },
    flush(controller) {
      if (buffer.trim().startsWith("data: ")) {
        const dataStr = buffer.trim().slice(6);
        if (dataStr !== "[DONE]") {
          try {
            const googleEvent = JSON.parse(dataStr);
            const openaiEvent = transformGoogleEventToOpenAI(googleEvent, model, requestId, currentHasPriorToolCalls, activeSignature);
            if (openaiEvent) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(openaiEvent)}\n\n`));
            }
          } catch (e) {
            console.warn("[Stream] Failed to parse final line in flush:", e);
          }
        }
      }
    }
  });
}
