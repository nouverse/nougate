/**
 * The upstream is Anthropic, so the Anthropic protocol needs no translation at all. Kept as a
 * re-export so provider code has a stable local import path, as Copilot's mappers do.
 */
export { sanitizeAnthropicBody } from '@/core/mappers/anthropic-passthrough';
