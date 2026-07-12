import type { IProvider } from "../../core/interfaces";
import { registerHandler } from "../../core/registry";
import { OpenAIProtocolHandler } from "./handler";

/**
 * Register the OpenAI-compatible protocol routes.
 */
export function registerOpenAIProtocol(_provider: IProvider): void {
  registerHandler(new OpenAIProtocolHandler());
}

export { OpenAIProtocolHandler } from "./handler";
export { mapOpenAIToGoogle } from "./mapper-in";
export {
  createOpenAIStreamTransformer,
  transformGoogleEventToOpenAI,
} from "./mapper-out";
