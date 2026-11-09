/**
 * Codex request transformation — the full pipeline from 9router's executor.
 *
 * Handles: system→developer role conversion, stored item ref stripping, tool normalization,
 * reasoning effort parsing, allowlist filtering, default instructions injection, and more.
 */

import { CODEX_DEFAULT_INSTRUCTIONS } from '../config/codex-instructions';
import { CODEX_EFFORT_LEVELS } from '../config/model-specs';

// Server-generated item id prefixes that Codex /responses cannot resolve when store=false
const SERVER_ID_PATTERN = /^(rs|fc|resp|msg)_/;

// Hosted tool types that Codex/OpenAI Responses executes server-side
const CODEX_HOSTED_TOOL_TYPES = new Set([
  'image_generation', 'web_search', 'web_search_preview', 'file_search',
  'computer', 'computer_use_preview', 'code_interpreter', 'mcp', 'local_shell',
  'tool_search',
]);

// Responses-native freeform tools carry a name plus format payload and must pass through intact
const CODEX_PASSTHROUGH_TOOL_TYPES = new Set(['custom']);

// Allowlist of fields accepted by Codex Responses API — anything else is stripped
const RESPONSES_API_ALLOWLIST = new Set([
  'model', 'input', 'instructions', 'tools', 'tool_choice', 'stream', 'store',
  'reasoning', 'service_tier', 'include', 'prompt_cache_key', 'client_metadata',
  'text',
]);

/** Supported reasoning effort levels for normalization. */
const SUPPORTED_THINKING_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];

/** Convert role=system → role=developer in body.input (keeps content in cacheable prefix). */
function convertSystemToDeveloperRole(body: Record<string, any>): void {
  if (!Array.isArray(body.input)) return;
  for (const item of body.input) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const isSystemMsg = item.role === 'system' && (!item.type || item.type === 'message');
    if (isSystemMsg) item.role = 'developer';
  }
}

/** Strip server-generated item IDs (rs_/fc_/resp_/msg_) from input — avoids 404 with store=false. */
function stripStoredItemReferences(body: Record<string, any>): void {
  if (!Array.isArray(body.input)) return;
  body.input = body.input.filter((item: any) => {
    if (typeof item === 'string' && SERVER_ID_PATTERN.test(item)) return false;
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      if (item.type === 'item_reference') return false;
      if (typeof item.id === 'string' && SERVER_ID_PATTERN.test(item.id)) delete item.id;
    }
    return true;
  });
}

/**
 * Flatten Chat-Completions tool shape into Responses flat format + filter unsupported tools.
 *
 * Chat Completions: `{type:"function", function:{name,description,parameters}}`
 * Responses API:    `{type:"function", name, description, parameters}`
 */
function normalizeCodexTools(body: Record<string, any>): void {
  if (!Array.isArray(body.tools)) return;
  const validNames = new Set<string>();
  body.tools = body.tools.filter((tool: any) => {
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return false;
    const type = typeof tool.type === 'string' ? tool.type : '';

    // Namespace tools pass through with sub-tools
    if (type === 'namespace') {
      if (Array.isArray(tool.tools)) {
        for (const st of tool.tools) {
          const n = typeof st?.name === 'string' ? st.name.trim().slice(0, 128) : '';
          if (n) validNames.add(n);
        }
      }
      return true;
    }

    // Non-function types: passthrough or hosted
    if (type !== 'function') {
      if (CODEX_PASSTHROUGH_TOOL_TYPES.has(type)) return true;
      if (!type || tool.function || typeof tool.name === 'string') return false;
      return CODEX_HOSTED_TOOL_TYPES.has(type);
    }

    // Function tools: flatten from Chat Completions shape
    const fn = tool.function && typeof tool.function === 'object' && !Array.isArray(tool.function) ? tool.function : null;
    const rawName = typeof tool.name === 'string' ? tool.name : (typeof fn?.name === 'string' ? fn.name : '');
    const name = rawName.trim();
    if (!name) return false;

    const description = typeof tool.description === 'string' ? tool.description : (typeof fn?.description === 'string' ? fn.description : '');
    const parameters = (tool.parameters && typeof tool.parameters === 'object' && !Array.isArray(tool.parameters))
      ? tool.parameters
      : (fn?.parameters && typeof fn.parameters === 'object' && !Array.isArray(fn.parameters) ? fn.parameters : { type: 'object', properties: {} });

    // Clear all keys and rebuild in Responses format
    for (const k of Object.keys(tool)) delete tool[k];
    tool.type = 'function';
    tool.name = name.slice(0, 128);
    if (description) tool.description = description;
    tool.parameters = parameters;
    validNames.add(name);
    return true;
  });

  // Drop tool_choice if it references an unknown function name
  if (body.tool_choice && typeof body.tool_choice === 'object' && !Array.isArray(body.tool_choice)) {
    if (body.tool_choice.type === 'function') {
      const n = typeof body.tool_choice.name === 'string' ? body.tool_choice.name.trim() : '';
      if (!n || !validNames.has(n)) delete body.tool_choice;
    }
  }
}

/**
 * Normalize reasoning effort level against supported levels.
 */
function normalizeReasoningEffort(value: string): string {
  if (SUPPORTED_THINKING_LEVELS.includes(value)) return value;
  if (value === 'ultra' || value === 'max') return 'xhigh';
  return value;
}

/**
 * Normalize Responses API input to array format.
 * String input → array with one user message. Empty array → placeholder message.
 */
function normalizeResponsesInput(input: any): any[] | null {
  if (typeof input === 'string') {
    const text = input.trim() === '' ? '...' : input;
    return [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }];
  }
  if (Array.isArray(input)) {
    if (input.length === 0) {
      return [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '...' }] }];
    }
    return input;
  }
  return null;
}

export interface TransformContext {
  sessionId?: string;
}

/**
 * The full Codex request transformation pipeline.
 *
 * Matches 9router's `CodexExecutor.transformRequest()` exactly.
 *
 * @returns The mutated body and whether `/compact` URL suffix should be used.
 */
export function transformCodexRequest(
  model: string,
  body: Record<string, any>,
  _ctx: TransformContext = {},
): { body: Record<string, any>; isCompact: boolean } {
  const isCompact = !!body._compact;
  delete body._compact;

  // Convert string input to array format (Codex API requires input as array)
  const normalized = normalizeResponsesInput(body.input);
  if (normalized) body.input = normalized;

  // Ensure input is present and non-empty
  if (!body.input || (Array.isArray(body.input) && body.input.length === 0)) {
    body.input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '...' }] }];
  }

  // Keep system prompts in body.input as role=developer so they stay in the cacheable prefix
  convertSystemToDeveloperRole(body);
  // Strip server-generated item IDs — Codex /responses can't resolve when store=false
  stripStoredItemReferences(body);
  // Flatten function tools + drop unsupported types
  normalizeCodexTools(body);

  // Ensure streaming is enabled (Codex API requires it)
  body.stream = true;

  // If no instructions provided, inject default Codex instructions
  if (!body.instructions || (typeof body.instructions === 'string' && body.instructions.trim() === '')) {
    body.instructions = CODEX_DEFAULT_INSTRUCTIONS;
  }

  // Ensure store is false (Codex requirement)
  body.store = false;

  body.model = body.model || model;

  // Extract thinking level from model name suffix
  // e.g., gpt-5.3-codex-high → high, gpt-5.3-codex → medium (default)
  let modelEffort: string | null = null;
  for (const level of CODEX_EFFORT_LEVELS) {
    if (body.model.endsWith(`-${level}`)) {
      modelEffort = level;
      body.model = body.model.replace(`-${level}`, '');
      break;
    }
  }

  // Priority: explicit reasoning.effort > reasoning_effort param > model suffix > default (low)
  if (!body.reasoning) {
    const effort = normalizeReasoningEffort(body.reasoning_effort || modelEffort || 'low');
    body.reasoning = { effort, summary: 'auto' };
  } else {
    body.reasoning.effort = normalizeReasoningEffort(body.reasoning.effort);
    if (!body.reasoning.summary) body.reasoning.summary = 'auto';
  }
  delete body.reasoning_effort;

  // Include reasoning encrypted content (required by Codex backend for reasoning models)
  if (body.reasoning && body.reasoning.effort && body.reasoning.effort !== 'none') {
    body.include = ['reasoning.encrypted_content'];
  }

  // Remove unsupported parameters for Codex API
  delete body.temperature;
  delete body.top_p;
  delete body.frequency_penalty;
  delete body.presence_penalty;
  delete body.logprobs;
  delete body.top_logprobs;
  delete body.n;
  delete body.seed;
  delete body.max_tokens;
  delete body.max_completion_tokens;
  delete body.max_output_tokens;
  delete body.user;
  delete body.prompt_cache_retention;
  delete body.metadata;
  delete body.stream_options;
  delete body.safety_identifier;
  delete body.previous_response_id; // store=false → backend can't resolve previous resp

  if (body.service_tier === 'fast') body.service_tier = 'priority';
  if (body.service_tier && body.service_tier !== 'priority') delete body.service_tier;

  // Final allowlist filter — strip any unknown field that could trigger upstream "routing_unsupported"
  for (const k of Object.keys(body)) {
    if (!RESPONSES_API_ALLOWLIST.has(k)) delete body[k];
  }

  return { body, isCompact };
}
