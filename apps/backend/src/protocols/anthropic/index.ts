import { registerHandler } from "@/core/registry";
import { AnthropicProtocolHandler } from "@/protocols/anthropic/handler";

/**
 * Register the Anthropic-compatible protocol routes.
 */
export function registerAnthropicProtocol(): void {
  registerHandler(new AnthropicProtocolHandler());
}

export { AnthropicProtocolHandler } from "@/protocols/anthropic/handler";
export { mapAnthropicToGoogle } from "@/providers/antigravity/mappers/anthropic-in";
export {
  createAnthropicStreamTransformer,
  aggregateAnthropicResponse,
} from "@/providers/antigravity/mappers/anthropic-out";
