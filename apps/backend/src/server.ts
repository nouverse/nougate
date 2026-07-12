#!/usr/bin/env bun
import { registerProvider } from "@/core/registry";
import { loadProxyConfig } from "@/config/manager";
import { refreshAllQuotas } from "@/providers/antigravity/api/quota";
import { getAntigravityConfig, AntigravityProvider } from "@/providers/antigravity";
import { registerOpenAIProtocol } from "@/protocols/openai";
import { registerAnthropicProtocol } from "@/protocols/anthropic";
import { handleRequest } from "@/router";
import { setupLogCapture } from "@/router/middleware";

await loadProxyConfig();
setupLogCapture();

const antigravityProvider = new AntigravityProvider();
await antigravityProvider.init();
registerProvider(antigravityProvider);
registerOpenAIProtocol();
registerAnthropicProtocol();

const antigravityConfig = getAntigravityConfig();
setInterval(refreshAllQuotas, antigravityConfig.quota.refreshIntervalMs);
refreshAllQuotas();

const pkg = await Bun.file("package.json").json();

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  idleTimeout: 0,
  fetch: handleRequest,
});

console.log(
  `Nougate v${pkg.version || "0.0.0"} running on port ${PORT}`,
);
