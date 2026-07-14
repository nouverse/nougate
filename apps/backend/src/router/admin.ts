import { join } from "path";
import { existsSync } from "fs";
import { getProxyConfig, updateProxyConfig } from "@/config/manager";
import { adminEventBus } from "@/core/events";
import { addAccount } from "@/providers/antigravity/auth/manager";
import { exchangeCode, generateAuthUrl, getProjectId, getUserEmail } from "@/providers/antigravity/auth/oauth";
import type { AntigravityAccount } from "@/providers/antigravity/auth/types";
import { fetchQuota } from "@/providers/antigravity/api/quota";
import { getCapturedLogs } from "@/router/middleware";
import { getAllProviders, getProvider, getDefaultProvider } from "@/core/registry";

const pkg = await Bun.file("package.json").json();
const APP_VERSION = pkg.version || "0.0.0";

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
 * Combine global proxy config with provider-local config for the admin API.
 */
function buildCombinedConfig() {
  const proxyConfig = getProxyConfig();
  const defaultProvider = getDefaultProvider();
  const providerConfig = defaultProvider.getConfig?.() || {};

  return {
    ...proxyConfig,
    models: providerConfig.models,
    quota: providerConfig.quota,
    endpoints: providerConfig.endpoints,
    features: providerConfig.features,
    scheduling: providerConfig.scheduling,
  };
}

/**
 * Split admin config updates into global and provider-local payloads.
 */
function splitConfigUpdates(updates: any) {
  const proxyUpdates: any = {};
  const providerUpdates: any = {};

  for (const key of ["rotation", "scoring", "retry", "tokens", "logging"]) {
    if (key in updates) {
      proxyUpdates[key] = updates[key];
    }
  }

  for (const key of ["quota", "endpoints", "features", "scheduling"]) {
    if (key in updates) {
      providerUpdates[key] = updates[key];
    }
  }

  if (updates.models?.blacklist) {
    providerUpdates.models = { blacklist: updates.models.blacklist };
  }

  return { proxyUpdates, providerUpdates };
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
 */
function serveFrontendAsset(pathname: string): Response {
  const relativePath = pathname.replace("/frontend/", "") || "index.html";
  const lastSegment = relativePath.split("/").pop() || "";
  const isFile = lastSegment.includes(".");
  
  const distDir = [
    join(import.meta.dir, "../../../frontend/dist"),
    join(process.cwd(), "apps/frontend/dist"),
    join(process.cwd(), "frontend/dist"),
  ].find((dir) => existsSync(dir)) || join(import.meta.dir, "../../../frontend/dist");
  
  if (!isFile) {
    return new Response(Bun.file(join(distDir, "index.html")));
  }
  
  return new Response(Bun.file(join(distDir, relativePath)));
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
    const config = getProxyConfig();
    const baseUrl = config?.baseUrl || "http://localhost:3000";
    return Response.redirect(`${baseUrl.replace(/\/$/, "")}/frontend/`);
  } catch (error) {
    return new Response(`Auth error: ${error}`, { status: 500 });
  }
}

/**
 * Handle the non-protocol admin, OAuth, and frontend routes.
 */
export async function handleAdminRoute(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname === "/oauth/start") {
    return Response.redirect(generateAuthUrl());
  }

  if (url.pathname === "/oauth-callback") {
    return handleOAuthCallback(url);
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

  if (url.pathname === "/api/config" && req.method === "GET") {
    return createJsonResponse(buildCombinedConfig());
  }

  if (url.pathname === "/api/config" && req.method === "POST") {
    const body = await req.json();
    try {
      const { proxyUpdates, providerUpdates } = splitConfigUpdates(body);
      if (Object.keys(proxyUpdates).length > 0) {
        await updateProxyConfig(proxyUpdates);
      }
      const defaultProvider = getDefaultProvider();
      if (defaultProvider.updateConfig && Object.keys(providerUpdates).length > 0) {
        await defaultProvider.updateConfig(providerUpdates);
      }
      return createJsonResponse(buildCombinedConfig());
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
        modelCount: p.getSupportedModels().length,
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
        return createJsonResponse({ error: error.message || error }, 400);
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
      return createJsonResponse({
        id: p.id,
        displayName: p.displayName,
        config,
        models,
        accounts,
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
          return createJsonResponse({ error: error.message || error }, 400);
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
