/**
 * An OpenAI-speaking client against an Anthropic upstream — the shared core translation, in the
 * direction Copilot never needs and this provider always does.
 */
export {
  mapOpenAIToAnthropic,
  createAnthropicToOpenAIStreamTransformer,
  finalizeAnthropicToOpenAIResponse,
} from '@/core/mappers/openai-to-anthropic';
