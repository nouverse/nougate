/**
 * Anthropic → Anthropic passthrough mapping.
 *
 * Used when both the client protocol and the upstream speak the Messages API: the body needs a model
 * swap, an allowlist, and the Caveman prompt when that mode is on. Nothing is translated, which is
 * the point — a passthrough that "helpfully" rewrites a field is a passthrough that breaks the next
 * feature Anthropic ships before anybody here has heard of it.
 *
 * ## The allowlist is deliberately generous, and that is the opposite of the OpenAI one
 *
 * There, unknown keys are dropped because OpenAI-compatible servers vary and a field one accepts
 * another rejects. Here the upstream is Anthropic itself, so a field this gateway does not recognise
 * is far more likely to be one it has not been taught yet — `output_config`, `thinking`, `betas`,
 * `context_management` all arrived after code like this was first written. Dropping them silently
 * would make a current client behave like an old one, with no error to explain why.
 *
 * So the list carries everything the Messages API documents, and the rule for adding to it is simply
 * "Anthropic accepts it". `model` is the one field that is always overwritten rather than copied.
 */

import { getCavemanPrompt } from '@/core/caveman';

const ALLOWED_KEYS = [
  'messages',
  'system',
  'max_tokens',
  'stream',
  'temperature',
  'top_p',
  'top_k',
  'stop_sequences',
  'tools',
  'tool_choice',
  'metadata',
  'thinking',
  'output_config',
  'context_management',
  'betas',
  'service_tier',
  'speed',
  'fallbacks',
  'mcp_servers',
  'container',
  'inference_geo',
];

export function sanitizeAnthropicBody(anthropicBody: any, upstreamModelId: string) {
  const body: any = { model: upstreamModelId };

  for (const key of ALLOWED_KEYS) {
    if (key in anthropicBody && anthropicBody[key] !== undefined) {
      body[key] = anthropicBody[key];
    }
  }

  /**
   * `max_tokens` is required by the Messages API — a request without it is a 400, not a default.
   *
   * A client that omitted it was going to fail upstream either way; filling it in here turns an
   * error nobody can act on into a working request.
   */
  if (typeof body.max_tokens !== 'number') {
    body.max_tokens = 4096;
  }

  const cavemanPrefix = getCavemanPrompt();
  if (cavemanPrefix) {
    // `system` is a top-level field here, not a message — and it is either a string or a block list.
    // Both forms are kept in their own shape rather than normalised to one, because normalising
    // would drop the `cache_control` breakpoints a block list carries.
    if (typeof body.system === 'string') {
      body.system = `${cavemanPrefix}\n\n${body.system}`;
    } else if (Array.isArray(body.system)) {
      body.system = [{ type: 'text', text: cavemanPrefix }, ...body.system];
    } else {
      body.system = cavemanPrefix;
    }
  }

  return body;
}
