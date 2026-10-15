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

import { getAllProviders, registerProvider } from "@/core/registry";
import { loadProxyConfig } from "@/config/manager";
import { AntigravityProvider } from "@/providers/antigravity";
import { CopilotProvider } from "@/providers/copilot";
import { ClaudeCodeProvider } from "@/providers/claudecode";
import { CodexProvider } from "@/providers/codex";
import { KiroProvider } from "@/providers/kiro";
import { registerOpenAIProtocol } from "@/protocols/openai";
import { registerAnthropicProtocol } from "@/protocols/anthropic";
import { handleRequest } from "@/router";
import { setupLogCapture } from "@/router/middleware";
import { initDb } from "@/core/db";
import { createApiKey, initApiKeys, verifyApiKey } from "@/auth/api-keys";
import { clearUsers, initUsers } from "@/auth/users";
import { initCustomProviders } from "@/providers/custom/manager";
import { startMetricsMaintenance } from "@/core/metrics/maintenance";
import { initCalibration } from "@/core/metrics/calibrator";
import { type HostResolver, setHostResolver } from "@/core/host";
import { formatModelId } from "@/core/model-resolver";

export type { HostRequest, HostResolver } from "@/core/host";
/** Whether the dashboard on disk can be shown inside a host — see `router/frontend-dist.ts`. */
export { dashboardEmbeddable } from "@/router/frontend-dist";

export interface BootOptions {
  /**
   * A host that runs this gateway inside itself and vouches for its own signed-in users — see
   * `core/host.ts`. Absent for a standalone gateway, which is its own sign-in.
   */
  host?: HostResolver;
}

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
export async function boot(options: BootOptions = {}): Promise<(req: Request) => Response | Promise<Response>> {
  // First, so nothing that answers a request can run before the host is known.
  setHostResolver(options.host ?? null);
  await loadProxyConfig();
  setupLogCapture();
  await initDb();
  await initUsers();
  await initApiKeys();
  await initCalibration();

  // Registration order is display order: `getAllProviders()` hands them back in this sequence and
  // both the dashboard sidebar and the provider list render it unsorted. Which provider is the
  // *default* is decided by id in `core/registry`, not by position, so this list can be reordered
  // freely.
  const antigravityProvider = new AntigravityProvider();
  await antigravityProvider.init();
  registerProvider(antigravityProvider);

  const codexProvider = new CodexProvider();
  await codexProvider.init();
  registerProvider(codexProvider);

  const claudeCodeProvider = new ClaudeCodeProvider();
  await claudeCodeProvider.init();
  registerProvider(claudeCodeProvider);

  const copilotProvider = new CopilotProvider();
  await copilotProvider.init();
  registerProvider(copilotProvider);

  const kiroProvider = new KiroProvider();
  await kiroProvider.init();
  registerProvider(kiroProvider);

  // Registered last so a custom provider can never shadow a built-in ID.
  await initCustomProviders();
  startMetricsMaintenance();

  registerOpenAIProtocol();
  registerAnthropicProtocol();

  return handleRequest;
}

/**
 * Remove every account so the next boot starts from `INITIAL_ADMIN_*`, as a new install does.
 *
 * For a host that offers "reset sign-in" — the Nouride Box's setup console resets its own accounts
 * and this gateway's together — without it reaching into this gateway's database. Call it after
 * `boot()`, then restart: the accounts are recreated on the way up, not here. Returns how many were
 * removed.
 */
export async function resetAccounts(): Promise<number> {
  return clearUsers();
}

/**
 * Copy this gateway's state from where the host kept it before, once — see `adoptStateFrom`. Call
 * it before `boot()`.
 */
export { adoptStateFrom } from "@/core/paths";

/**
 * A gateway key for the host itself — the one its own model calls carry. After `boot()`.
 *
 * The host stores the key and hands back what it stored as `current`. A key that still verifies is
 * returned as it is and nothing is minted, so asking twice — a wizard button pressed twice, a daemon
 * restarted mid-setup — does not leave a trail of keys on the API Keys page. Anything else (none
 * stored, revoked from the dashboard, expired, from a gateway that was reset) mints a new one.
 *
 * The plaintext leaves this function exactly once per key, as `createApiKey` promises: only the hash
 * is kept here.
 */
export async function ensureHostKey(
  name: string,
  current?: string | null,
): Promise<{ key: string; minted: boolean }> {
  if (current && verifyApiKey(current).ok) {
    return { key: current, minted: false };
  }
  const created = await createApiKey({ name });
  return { key: created.key, minted: true };
}

/**
 * Every model that can be called right now, prefixed the way a client sends it. After `boot()`.
 *
 * `/openai/v1/models` lists every model of every provider, signed in or not, which is right for a
 * client that wants the catalogue and wrong for a host picking a first model: the alphabetical first
 * entry is usually a provider nobody has signed in to, and the first message then fails. This is the
 * catalogue narrowed to providers that hold at least one account — a custom provider's keys count.
 */
export function connectedModels(): string[] {
  return getAllProviders()
    .filter((provider) => {
      try {
        return provider.getAccounts().length > 0;
      } catch {
        return false;
      }
    })
    .flatMap((provider) =>
      provider.getModelRegistry().listModelIds().map((modelId) => formatModelId(provider.id, modelId)),
    )
    .sort((a, b) => a.localeCompare(b));
}
