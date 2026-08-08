#!/usr/bin/env bun
import { registerProvider } from "@/core/registry";
import { loadProxyConfig } from "@/config/manager";
import { loadAuthConfig } from "@/auth/config";
import { AntigravityProvider } from "@/providers/antigravity";
import { CopilotProvider } from "@/providers/copilot";
import { registerOpenAIProtocol } from "@/protocols/openai";
import { registerAnthropicProtocol } from "@/protocols/anthropic";
import { handleRequest } from "@/router";
import { setupLogCapture } from "@/router/middleware";
import { initDb } from "@/core/db";
import { initApiKeys } from "@/auth/api-keys";
import { initCustomProviders } from "@/providers/custom/manager";
import { startMetricsMaintenance } from "@/core/metrics/maintenance";

await loadProxyConfig();
loadAuthConfig();
setupLogCapture();
initDb();
initApiKeys();

const antigravityProvider = new AntigravityProvider();
await antigravityProvider.init();
registerProvider(antigravityProvider);

const copilotProvider = new CopilotProvider();
await copilotProvider.init();
registerProvider(copilotProvider);

// Registered last so a custom provider can never shadow a built-in ID.
initCustomProviders();
startMetricsMaintenance();

registerOpenAIProtocol();
registerAnthropicProtocol();

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
