import { registerHandler } from "../../core/registry";
import { AnthropicProtocolHandler } from "./handler";

/**
 * Register the Anthropic-compatible protocol routes.
 */
export function registerAnthropicProtocol(): void {
  registerHandler(new AnthropicProtocolHandler());
}

export { AnthropicProtocolHandler } from "./handler";
export { mapAnthropicToGoogle } from "./mapper-in";
export {
  createAnthropicStreamTransformer,
  aggregateAnthropicResponse,
} from "./mapper-out";
