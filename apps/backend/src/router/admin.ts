import { dirname, join } from "path";
import { existsSync } from "fs";
import { getProxyConfig, updateProxyConfig } from "@/config/manager";
import { adminEventBus } from "@/core/events";
import { getBaseUrl } from "@/core/base-url";
import { AccountLimitError, getMaxAccountMultiplexing } from "@/core/rotation-pool";
import { addAccount } from "@/providers/antigravity/auth/manager";
import { exchangeCode, generateAuthUrl, getProjectId, getUserEmail } from "@/providers/antigravity/auth/oauth";
import type { AntigravityAccount } from "@/providers/antigravity/auth/types";
import { fetchQuota } from "@/providers/antigravity/api/quota";
import { getCapturedLogs } from "@/router/middleware";
import { getAllProviders, getProvider, getDefaultProvider } from "@/core/registry";
import { handleMetricsRoute } from "@/router/metrics";
import { handleApiKeysRoute } from "@/router/api-keys";
import { handleCustomProvidersRoute } from "@/router/custom-providers";
import { handleUsersRoute } from "@/router/users";
import { CustomProvider } from "@/providers/custom";
import { resolvePricing } from "@/core/metrics/pricing";
import { smartRoutableModels } from "@/core/smart-routing";
import { projectPath } from "@/core/paths";
import { NOUGATE_VERSION } from "@/core/version";

const APP_VERSION = NOUGATE_VERSION;

/**
 * Build a JSON response with the shared admin payload format.
 */
function createJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

/**
 * Create the admin SSE stream used by the dashboard.
 */
function createAdminEventStream(): Response {
  let onUpdate: ((data: any) => void) | undefined;
  let onFlash: ((data: { email: string; status: "success" | "error" }) => void) | undefined;
  let onLog: ((message: string) => void) | undefined;
  let onCooldown: ((data: any) => void) | undefined;

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (event: string, data: any) => {
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
        }
      };

      const defaultProvider = getDefaultProvider();
      const allAccounts = getAllProviders().flatMap((p) => p.getAccounts());
      const strategy = defaultProvider.getStrategy?.() || "hybrid";
      const allModels = Array.from(new Set(getAllProviders().flatMap((p) => p.getSupportedModels()))).sort();
      const cooldowns = defaultProvider.getCooldowns?.() || {};

      send("init", {
        version: APP_VERSION,
        accounts: allAccounts,
        strategy,
        supportedModels: allModels,
        cooldowns,
        logs: getCapturedLogs(),
      });

      onUpdate = (data: any) => {
        const models = Array.from(new Set(getAllProviders().flatMap((p) => p.getSupportedModels()))).sort();
        send("update", {
          ...data,
          supportedModels: models,
        });
      };
      onFlash = (data: { email: string; status: "success" | "error" }) =>
        send("flash", data);
      onLog = (message: string) => send("log", { message });
      onCooldown = (data: any) => send("cooldown", data);

      adminEventBus.on("update", onUpdate);
      adminEventBus.on("flash", onFlash);
      adminEventBus.on("log", onLog);
      adminEventBus.on("cooldown", onCooldown);
    },
    cancel() {
      if (onUpdate) {
        adminEventBus.off("update", onUpdate);
      }
      if (onFlash) {
        adminEventBus.off("flash", onFlash);
      }
      if (onLog) {
        adminEventBus.off("log", onLog);
      }
      if (onCooldown) {
        adminEventBus.off("cooldown", onCooldown);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

/**
 * Read and serve a frontend asset from the embedded dashboard bundle.
 *
 * Vite fingerprints asset filenames, so those are safe to cache forever. The
 * entry document must never be cached: it is what points at the current bundle,
 * and a stale copy keeps serving an old dashboard after a rebuild — which shows
 * up as a route that "does not exist" rather than as an obvious caching problem.
 */
function serveFrontendAsset(pathname: string): Response {
  const relativePath = pathname.replace("/frontend/", "") || "index.html";
  const lastSegment = relativePath.split("/").pop() || "";
  const isFile = lastSegment.includes(".");

  /**
   * Where the built dashboard is, checked in order and remembered by nobody — this runs per request,
   * and `existsSync` on four paths is cheaper than the file read that follows it.
   *
   * The last entry is the compiled-binary layout: `bun build --compile` leaves `import.meta.dir`
   * pointing into a virtual filesystem, so the first three resolve to paths that are not on disk.
   * A release stages the dashboard as a sibling of the executable, the same way `nouride` does.
   *
   * ## The candidate is the entry document, not the directory
   *
   * It used to be `existsSync(dir)`, and an **empty** `dist` satisfies that. Vite builds with
   * `emptyOutDir: true`, so it clears the directory before it writes — a build that fails partway
   * leaves the directory in place with nothing in it. The check passed, the read did not, and the
   * dashboard answered `ENOENT: … /dist/index.html` with a 500.
   *
   * Testing for `index.html` makes an empty directory fall through to the next candidate, which in
   * a container is often a perfectly good copy at another path.
   */
  const candidates = [
    join(import.meta.dir, "../../../frontend/dist"),
    projectPath("apps/frontend/dist"),
    projectPath("frontend/dist"),
    join(dirname(process.execPath), "frontend"),
  ];
  const distDir = candidates.find((dir) => existsSync(join(dir, "index.html")));

  /**
   * No dashboard anywhere — said out loud, with where it looked.
   *
   * The alternative is what this used to do: hand back a `Bun.file` for a path that does not exist
   * and let the read fail, which surfaces as a bare ENOENT naming *one* of four candidates. That
   * error sent more than one person looking for a Docker `COPY` bug when the real answer was a
   * frontend build that had failed thirty seconds earlier.
   */
  if (!distDir) {
    return new Response(
      `The dashboard bundle is not built.\n\n` +
        `Looked in:\n${candidates.map((dir) => `  ${dir}`).join("\n")}\n\n` +
        `Run \`bun run build\` in apps/frontend, or check that the frontend build step succeeded — ` +
        `vite clears dist before it writes, so a failed build leaves the directory empty.\n`,
      { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } },
    );
  }

  if (!isFile) {
    return new Response(Bun.file(join(distDir, "index.html")), {
      headers: { "Cache-Control": "no-store, must-revalidate" },
    });
  }

  const isFingerprinted = relativePath.startsWith("assets/");
  return new Response(Bun.file(join(distDir, relativePath)), {
    headers: {
      "Cache-Control": isFingerprinted
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    },
  });
}

/**
 * Server-side OAuth callback for Claude Code.
 *
 * Anthropic redirects the browser here after the operator approves. The code is exchanged for
 * tokens, the account is stored, and the browser is redirected to the dashboard. This is the
 * same pattern Antigravity uses with `/oauth-callback`, but scoped under the provider path.
 */
async function handleClaudeCodeOAuthCallback(url: URL): Promise<Response> {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  if (!code) {
    return new Response('Missing authorization code', { status: 400 });
  }

  try {
    const provider = getProvider('claudecode');
    if (!provider?.addAccount) {
      return new Response('Claude Code provider not available', { status: 500 });
    }

    const result = await provider.addAccount({ code, state }) as { success?: boolean; email?: string };

    // The account is already stored by this point, so this page has one job: tell the dashboard that
    // it happened. `window.close()` is deliberately not attempted — this tab is opened by a link
    // rather than by script, and browsers refuse to close those, so trying produces a console error
    // and a tab that sits there anyway. The operator closes it; the dialog behind it has already gone.
    const email = result?.email || 'Claude account';
    return new Response(
      `<!DOCTYPE html>
<html><head><title>Authorized</title></head>
<body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#1d232a;color:#a6adbb">
<div style="text-align:center">
  <h2>✓ ${email} added</h2>
  <p>You can close this tab.</p>
  <script>
    if (window.opener) {
      // Addressed to this origin rather than to '*': the dashboard checks the sender, and a
      // message that says "an account was added" is not one to broadcast to whatever is listening.
      window.opener.postMessage({ type: 'claudecode-oauth-done' }, window.location.origin);
    } else {
      setTimeout(() => { window.location.href = '/frontend/'; }, 1500);
    }
  </script>
</div>
</body></html>`,
      { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    );
  } catch (error: any) {
    if (error instanceof AccountLimitError) {
      return new Response(error.message, {
        status: error.status,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
    return new Response(`OAuth error: ${error?.message || error}`, { status: 500 });
  }
}

/**
 * Handle provider OAuth callback and persist the authenticated account.
 */
async function handleOAuthCallback(url: URL): Promise<Response> {
  const code = url.searchParams.get("code");
  if (!code) {
    return new Response("Missing code", { status: 400 });
  }

  try {
    const tokenRes = await exchangeCode(code);
    const email = await getUserEmail(tokenRes.access_token);
    const projectId = await getProjectId(tokenRes.access_token);
    const newAccount: AntigravityAccount = {
      email,
      refreshToken: tokenRes.refresh_token!,
      accessToken: tokenRes.access_token,
      expiresAt: Date.now() + tokenRes.expires_in * 1000,
      projectId,
      healthScore: 100,
      lastUsed: 0,
      tokenUsage: 0,
    };

    if (!newAccount.refreshToken) {
      return new Response(
        "No refresh token received. Revoke access and try again.",
        { status: 400 },
      );
    }

    if (newAccount.projectId) {
      const quota = await fetchQuota(newAccount);
      if (quota) {
        newAccount.quota = quota;
      }
    }

    await addAccount(newAccount);
    return Response.redirect(`${getBaseUrl()}/frontend/`);
  } catch (error) {
    // This callback lands in a browser tab, so the account cap has to explain
    // itself in plain text rather than arriving as "Auth error: [object]".
    if (error instanceof AccountLimitError) {
      return new Response(error.message, {
        status: error.status,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    return new Response(`Auth error: ${error}`, { status: 500 });
  }
}

/**
 * Handle the non-protocol admin, OAuth, and frontend routes.
 */
export async function handleAdminRoute(req: Request, url: URL): Promise<Response | null> {
  const metricsResponse = await handleMetricsRoute(req, url);
  if (metricsResponse) {
    return metricsResponse;
  }

  const apiKeysResponse = await handleApiKeysRoute(req, url);
  if (apiKeysResponse) {
    return apiKeysResponse;
  }

  const customProvidersResponse = await handleCustomProvidersRoute(req, url);
  if (customProvidersResponse) {
    return customProvidersResponse;
  }

  const usersResponse = await handleUsersRoute(req, url);
  if (usersResponse) {
    return usersResponse;
  }

  if (url.pathname === "/oauth/start") {
    return Response.redirect(generateAuthUrl());
  }

  if (url.pathname === "/oauth-callback") {
    return handleOAuthCallback(url);
  }

  // Claude Code OAuth callback — path must be exactly `/callback` because the CLI's client_id
  // only allows `http://localhost:{port}/callback` as a registered redirect URI.
  if (url.pathname === '/callback') {
    return handleClaudeCodeOAuthCallback(url);
  }

  if (url.pathname === "/api/sse") {
    return createAdminEventStream();
  }

  if (url.pathname === "/api/status") {
    const defaultProvider = getDefaultProvider();
    const allAccounts = getAllProviders().flatMap((p) => p.getAccounts());
    const strategy = defaultProvider.getStrategy?.() || "hybrid";
    const allModels = Array.from(new Set(getAllProviders().flatMap((p) => p.getSupportedModels()))).sort();
    return createJsonResponse({
      version: APP_VERSION,
      accounts: allAccounts,
      strategy,
      supportedModels: allModels,
    });
  }

  // Full catalogue of callable models, prefixed exactly as a client must send
  // them. Served from the admin side so the dashboard does not need a gateway
  // API key to populate the playground's model picker.
  if (url.pathname === "/api/models" && req.method === "GET") {
    const smartRoutable = smartRoutableModels();
    const models = getAllProviders().flatMap((p) => {
      const registry = p.getModelRegistry();
      return registry.listModelIds().map((modelId) => {
        const spec = registry.getSpec(modelId);
        // Resolved (not raw) pricing, so a cost shown here matches what the
        // metrics dashboard bills the same request at.
        const pricing = resolvePricing(spec);

        return {
          id: `${p.id}:${modelId}`,
          providerId: p.id,
          providerName: p.displayName,
          modelId,
          displayName: spec?.displayName || modelId,
          isThinking: spec?.isThinking ?? false,
          maxOutputTokens: spec?.maxOutputTokens ?? 8192,
          inputPricePer1M: pricing.inputPricePer1M,
          outputPricePer1M: pricing.outputPricePer1M,
          /** False when no rate is known, so cost is reported as $0. */
          isPriced: pricing.isPriced,
          isCustom: p instanceof CustomProvider,
          /**
           * Providers that would serve this model called with no prefix at all, in the order routing
           * tries them. Empty only when nothing can currently serve it — a single entry still means
           * a bare call works, it just has nowhere to fall back to.
           */
          smartRoutedBy: smartRoutable.get(modelId) ?? [],
        };
      });
    });

    models.sort((a, b) => a.id.localeCompare(b.id));
    return createJsonResponse(models);
  }

  if (url.pathname === "/api/strategy" && req.method === "POST") {
    const body = await req.json() as { strategy?: 'hybrid' | 'sticky' | 'round-robin' | 'random' | 'least-used' };
    if (!body.strategy) {
      return new Response("Missing strategy", { status: 400 });
    }

    const defaultProvider = getDefaultProvider();
    if (defaultProvider.setStrategy) {
      await defaultProvider.setStrategy(body.strategy);
    }
    await updateProxyConfig({
      rotation: {
        ...getProxyConfig().rotation,
        strategy: body.strategy,
      },
    });
    return new Response("OK", { status: 200 });
  }

  // Global settings only. Provider-specific config (endpoints, quota, features,
  // scheduling, model blacklist) belongs to whichever provider owns it and is
  // served by /api/providers/:id/config — this endpoint used to graft the
  // *default* provider's config on top, which made settings that only apply to
  // Antigravity look global, and hid Copilot's and every custom provider's.
  if (url.pathname === "/api/config" && req.method === "GET") {
    return createJsonResponse(getProxyConfig());
  }

  if (url.pathname === "/api/config" && req.method === "POST") {
    const body = await req.json();
    try {
      // Unknown keys are dropped by updateProxyConfig's merge, so a stale
      // client posting provider keys here changes nothing rather than writing
      // them into the global file.
      await updateProxyConfig(body);
      return createJsonResponse(getProxyConfig());
    } catch (error: any) {
      return createJsonResponse({ error: error.message }, 400);
    }
  }

  if (url.pathname === "/api/accounts/reset-all" && req.method === "POST") {
    let count = 0;
    for (const p of getAllProviders()) {
      if (p.resetAllAccounts) {
        await p.resetAllAccounts();
        count += p.getAccounts().length;
      }
    }
    console.log(`[Manager] Reset state for all ${count} accounts via API`);
    return new Response("OK", { status: 200 });
  }

  // ─── Provider-scoped Account Actions ─────────────────────────────────────

  // DELETE /api/providers/:providerId/accounts/:accountId
  if (
    url.pathname.match(/^\/api\/providers\/[^\/]+\/accounts\/[^\/]+$/) &&
    req.method === "DELETE"
  ) {
    const parts = url.pathname.split("/");
    const providerId = parts[3];
    const accountId = decodeURIComponent(parts[5]);

    const p = getAllProviders().find((provider) => provider.id === providerId);
    if (!p) {
      return new Response("Provider not found", { status: 404 });
    }
    if (!p.removeAccount) {
      return new Response("Provider does not support account removal", { status: 400 });
    }

    await p.removeAccount(accountId);
    return new Response("OK", { status: 200 });
  }

  // POST /api/providers/:providerId/accounts/:accountId/action
  if (
    url.pathname.match(/^\/api\/providers\/[^\/]+\/accounts\/[^\/]+\/action$/) &&
    req.method === "POST"
  ) {
    const parts = url.pathname.split("/");
    const providerId = parts[3];
    const accountId = decodeURIComponent(parts[5]);

    const body = await req.json() as { action: string; payload?: any };
    if (!body.action) {
      return new Response("Missing action", { status: 400 });
    }

    const p = getAllProviders().find((provider) => provider.id === providerId);
    if (!p) {
      return new Response("Provider not found", { status: 404 });
    }
    if (!p.handleAccountAction) {
      return new Response("Provider does not support account actions", { status: 400 });
    }

    try {
      const result = await p.handleAccountAction(accountId, body.action, body.payload);
      return createJsonResponse(result ?? { ok: true });
    } catch (error: any) {
      return new Response(error.message, { status: 500 });
    }
  }

  // ─── Provider endpoints ───────────────────────────────────────────────────

  if (url.pathname === "/api/providers" && req.method === "GET") {
    const results = getAllProviders().map((p) => {
      let accounts: any[] = [];
      try {
        accounts = p.getAccounts();
      } catch {}
      return {
        id: p.id,
        displayName: p.displayName,
        accountCount: accounts.length,
        // Null when MAX_ACCOUNT_MULTIPLEXING is unset, which the dashboard
        // renders as a plain count rather than an "n / m" meter.
        accountLimit: getMaxAccountMultiplexing(),
        modelCount: p.getSupportedModels().length,
        // Lets the dashboard route custom providers to their own editor.
        isCustom: p instanceof CustomProvider,
      };
    });
    return createJsonResponse(results);
  }

  if (url.pathname.startsWith("/api/providers/") && req.method === "GET") {
    const parts = url.pathname.split("/");
    // GET /api/providers/copilot/device-status
    if (parts.length === 5 && parts[3] === "copilot" && parts[4] === "device-status") {
      const deviceCode = url.searchParams.get("device_code");
      if (!deviceCode) {
        return new Response("Missing device_code", { status: 400 });
      }
      const p = getProvider("copilot") as any;
      if (!p || typeof p.completeDeviceFlow !== "function") {
        return new Response("Device flow not supported on this provider", { status: 400 });
      }
      try {
        const result = await p.completeDeviceFlow(deviceCode);
        return createJsonResponse(result);
      } catch (error: any) {
        // The device flow can succeed at GitHub and still be refused here — the
        // account cap is checked when the account is stored, not when the code
        // is issued — so the status has to carry through.
        return createJsonResponse({ error: error.message || error }, error?.status ?? 400);
      }
    }

    // GET /api/providers/:id/config
    if (parts.length === 5 && parts[4] === "config") {
      const id = parts[3];
      const p = getProvider(id);
      if (!p) {
        return new Response("Provider not found", { status: 404 });
      }
      const config = p.getConfig ? p.getConfig() : {};
      return createJsonResponse(config);
    }
    // GET /api/providers/:id/models
    if (parts.length === 5 && parts[4] === "models") {
      const id = parts[3];
      const p = getProvider(id);
      if (!p) {
        return new Response("Provider not found", { status: 404 });
      }
      const modelIds = p.getModelRegistry().listModelIds();
      const models = modelIds.map((mid) => p.getModelRegistry().getSpec(mid));
      return createJsonResponse(models);
    }
    // GET /api/providers/:id/accounts
    if (parts.length === 5 && parts[4] === "accounts") {
      const id = parts[3];
      const p = getProvider(id);
      if (!p) {
        return new Response("Provider not found", { status: 404 });
      }
      return createJsonResponse(p.getAccounts());
    }
    // GET /api/providers/:id
    if (parts.length === 4) {
      const id = parts[3];
      const p = getProvider(id);
      if (!p) {
        return new Response("Provider not found", { status: 404 });
      }
      let accounts: any[] = [];
      try {
        accounts = p.getAccounts();
      } catch {}
      const modelIds = p.getModelRegistry().listModelIds();
      const models = modelIds.map((mid) => p.getModelRegistry().getSpec(mid));
      const config = p.getConfig ? p.getConfig() : {};

      // Capabilities are read off the contract, never off the provider id, so
      // any provider that implements getQuotas gains the tab for free.
      const supportsQuota = typeof p.getQuotas === "function";
      let quotas: any[] = [];
      if (supportsQuota) {
        try {
          quotas = await p.getQuotas!();
        } catch (error) {
          // A provider that cannot reach its upstream still has the capability;
          // the tab shows its empty state rather than vanishing.
          console.warn(`[Admin] ${p.id} failed to report quotas:`, error);
        }
      }

      return createJsonResponse({
        id: p.id,
        displayName: p.displayName,
        config,
        models,
        accounts,
        // Null when MAX_ACCOUNT_MULTIPLEXING is unset, which the dashboard
        // renders as a plain count rather than an "n / m" meter.
        accountLimit: getMaxAccountMultiplexing(),
        capabilities: { quota: supportsQuota, accountFlow: p.accountFlow ?? null },
        quotas,
      });
    }
  }

  if (url.pathname.startsWith("/api/providers/") && req.method === "POST") {
    const parts = url.pathname.split("/");
    // POST /api/providers/:id/config
    if (parts.length === 5 && parts[4] === "config") {
      const id = parts[3];
      const p = getProvider(id);
      if (!p) {
        return new Response("Provider not found", { status: 404 });
      }
      const body = await req.json();
      if (p.updateConfig) {
        try {
          const config = await p.updateConfig(body);
          return createJsonResponse(config);
        } catch (error: any) {
          return createJsonResponse({ error: error.message }, 400);
        }
      }
      return createJsonResponse({});
    }
    // POST /api/providers/:id/accounts/add
    if (parts.length === 6 && parts[4] === "accounts" && parts[5] === "add") {
      const id = parts[3];
      const p = getProvider(id);
      if (!p) {
        return new Response("Provider not found", { status: 404 });
      }
      if (p.addAccount) {
        let body: any = {};
        try {
          body = await req.json();
        } catch {
          // Empty body
        }
        try {
          const result = await p.addAccount(body);
          return createJsonResponse(result);
        } catch (error: any) {
          // A refusal that carries its own status keeps it: hitting the account
          // cap is a 409, not a malformed request.
          return createJsonResponse({ error: error.message || error }, error?.status ?? 400);
        }
      }
      return new Response("Not Supported", { status: 400 });
    }
  }

  if (url.pathname === "/frontend/index.html") {
    return Response.redirect("/frontend/");
  }

  if (url.pathname.startsWith("/frontend/")) {
    try {
      return serveFrontendAsset(url.pathname);
    } catch {
      return new Response("Not Found", { status: 404 });
    }
  }

  if (url.pathname === "/") {
    return Response.redirect("/frontend/");
  }

  return null;
}
