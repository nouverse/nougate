import { registerHandler } from "../../core/registry";
import { OpenAIProtocolHandler } from "./handler";

/**
 * Register the OpenAI-compatible protocol routes.
 */
export function registerOpenAIProtocol(): void {
  registerHandler(new OpenAIProtocolHandler());
}

export { OpenAIProtocolHandler } from "./handler";
export { mapOpenAIToGoogle } from "../../providers/antigravity/mappers/openai-in";
export {
  createOpenAIStreamTransformer,
  transformGoogleEventToOpenAI,
} from "../../providers/antigravity/mappers/openai-out";
