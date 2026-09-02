/**
 * Everything the gateway needs before it can answer a request, as a function instead of a module.
 *
 * ## Why this is split out of `server.ts`
 *
 * It was fifteen statements at module scope followed by `Bun.serve()`. That is fine for a program
 * whose only job is to be a process, and impossible for anything that wants to *host* it: importing
 * the module was the same as starting the server, on a port it chose from the environment.
 *
 * Nouride hosts it now — `bridge_transport = "inproc"` did the same thing for the WhatsApp bridge —
 * so the sequence is a function, `server.ts` is the standalone wiring around it, and neither the
 * providers nor the router know which of the two they are running under.
 *
 * ## What stays true either way
 *
 * The order matters and is unchanged. Config, then the database, then users and keys, then the
 * providers; custom providers **last**, so one of them can never shadow a built-in id. Protocols
 * after everything they dispatch into exists.
 */

import { registerProvider } from "@/core/registry";
import { loadProxyConfig } from "@/config/manager";
import { AntigravityProvider } from "@/providers/antigravity";
import { CopilotProvider } from "@/providers/copilot";
import { registerOpenAIProtocol } from "@/protocols/openai";
import { registerAnthropicProtocol } from "@/protocols/anthropic";
import { handleRequest } from "@/router";
import { setupLogCapture } from "@/router/middleware";
import { initDb } from "@/core/db";
import { initApiKeys } from "@/auth/api-keys";
import { initUsers } from "@/auth/users";
import { initCustomProviders } from "@/providers/custom/manager";
import { startMetricsMaintenance } from "@/core/metrics/maintenance";
import { initCalibration } from "@/core/metrics/calibrator";

/**
 * Bring the gateway up, without binding a port.
 *
 * Returns the fetch handler rather than a server, because who listens — and on what port, or whether
 * a port is involved at all — is the caller's business. `server.ts` hands it to `Bun.serve`; a host
 * process can do the same on a port of its own choosing.
 *
 * Idempotence is **not** claimed. The registries and the database handle are module state, so
 * calling this twice in one process would register every provider a second time. There is one
 * gateway per process; the host is expected to know that.
 */
export async function boot(): Promise<(req: Request) => Response | Promise<Response>> {
  await loadProxyConfig();
  setupLogCapture();
  await initDb();
  await initUsers();
  await initApiKeys();
  await initCalibration();

  const antigravityProvider = new AntigravityProvider();
  await antigravityProvider.init();
  registerProvider(antigravityProvider);

  const copilotProvider = new CopilotProvider();
  await copilotProvider.init();
  registerProvider(copilotProvider);

  // Registered last so a custom provider can never shadow a built-in ID.
  await initCustomProviders();
  startMetricsMaintenance();

  registerOpenAIProtocol();
  registerAnthropicProtocol();

  return handleRequest;
}
