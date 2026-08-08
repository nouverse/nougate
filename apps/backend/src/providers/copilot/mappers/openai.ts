/**
 * Copilot's upstream is OpenAI-shaped, so its OpenAI mapping is the shared
 * passthrough implementation. Kept as a re-export so provider code keeps a
 * stable local import path.
 */
export {
  sanitizeOpenAIBody as mapOpenAIToCopilot,
  createOpenAIStreamTransformer,
  finalizeOpenAIResponse,
} from '@/core/mappers/openai-passthrough';
