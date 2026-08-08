/**
 * Copilot speaks the OpenAI dialect upstream, so its Anthropic translation is
 * the shared core implementation. Kept as a re-export so provider code keeps a
 * stable local import path.
 */
export {
  mapAnthropicToOpenAI,
  createOpenAIToAnthropicStreamTransformer,
  finalizeOpenAIToAnthropicResponse,
} from '@/core/mappers/anthropic-to-openai';
