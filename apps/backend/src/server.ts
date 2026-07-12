#!/usr/bin/env bun
import { registerProvider } from "./core/registry";
import { loadProxyConfig } from "./config/manager";
import { refreshAllQuotas } from "./providers/antigravity/api/quota";
import { getAntigravityConfig, AntigravityProvider } from "./providers/antigravity";
import { registerOpenAIProtocol } from "./protocols/openai";
import { handleRequest } from "./router";
import { setupLogCapture } from "./router/middleware";

await loadProxyConfig();
setupLogCapture();

const antigravityProvider = new AntigravityProvider();
await antigravityProvider.init();
registerProvider(antigravityProvider);
registerOpenAIProtocol();

const antigravityConfig = getAntigravityConfig();
setInterval(refreshAllQuotas, antigravityConfig.quota.refreshIntervalMs);
refreshAllQuotas();

const pkg = await Bun.file("package.json").json();

Bun.serve({
  port: 3000,
  hostname: "0.0.0.0",
  idleTimeout: 0,
  fetch: handleRequest,
});

console.log(
  `Antigravity Proxy v${pkg.version || "0.0.0"} running on http://127.0.0.1:3000`,
);
