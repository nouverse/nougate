#!/usr/bin/env bun
import { loadProxyConfig, getProxyConfig, updateProxyConfig } from "./config/manager";
import { loadModelSpecOverrides } from "./providers/antigravity/config/model-specs";

await loadProxyConfig();
await loadModelSpecOverrides();

const pkg = await Bun.file("package.json").json();
const APP_VERSION = pkg.version || "0.0.0";

import { initManager, addAccount, getAccounts, removeAccount, getStrategy, setStrategy, saveAccounts, eventBus, markCooldown, getCooldowns, resetAccount, updateAccountProject, resetAllCooldowns } from "./providers/antigravity/auth/manager";
import { generateAuthUrl, exchangeCode, getUserEmail, getProjectId } from "./providers/antigravity/auth/oauth";
import { type SelectionStrategy, type AntigravityAccount } from "./providers/antigravity/auth/types";
import { refreshAllQuotas, fetchQuota, supportedModelsCache } from "./providers/antigravity/api/quota";
import { antigravityModelRegistry } from "./providers/antigravity/config/model-specs";
import type { IAccount, IProvider } from "./core/interfaces";
import { findHandler, getDefaultProvider, registerProvider } from "./core/registry";
import { resolveModel } from "./core/model-resolver";
import { registerOpenAIProtocol } from "./protocols/openai";
import { buildSessionId } from "./protocols/openai/handler";

const logBuffer: string[] = [];
const MAX_LOGS = 200;

function captureLog(level: string, args: any[]) {
    try {
        const msg = args.map(a => 
            (typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a))
        ).join(' ');
        const line = `[${new Date().toLocaleTimeString()}] [${level.toUpperCase()}] ${msg}`;
        
        logBuffer.push(line);
        if (logBuffer.length > MAX_LOGS) logBuffer.shift();
        
        eventBus.emit('log', line);
    } catch (e) {
    }
}


const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

console.log = (...args) => { originalLog(...args); captureLog('info', args); };
console.error = (...args) => { originalError(...args); captureLog('error', args); };
console.warn = (...args) => { originalWarn(...args); captureLog('warn', args); };

await initManager();

/**
 * Expose the current antigravity provider through the registry before phase 1.7
 * introduces a dedicated provider class.
 */
function createAntigravityProviderBridge(): IProvider {
    return {
        id: "antigravity",
        displayName: "Antigravity",
        async init() {
            await initManager();
        },
        async getBestAccount() {
            return null;
        },
        async updateAccountUsage() {
        },
        getAccounts(): IAccount[] {
            return getAccounts().map((account) => ({
                id: account.email,
                providerId: "antigravity",
                healthScore: account.healthScore,
                lastUsed: account.lastUsed,
                capabilities: account.capabilities,
            }));
        },
        getModelRegistry() {
            return antigravityModelRegistry;
        },
    };
}

const antigravityProvider = createAntigravityProviderBridge();
registerProvider(antigravityProvider);
registerOpenAIProtocol(antigravityProvider);

const proxyConfig = getProxyConfig();

setInterval(refreshAllQuotas, proxyConfig.quota.refreshIntervalMs);
// Initial quota refresh on startup
refreshAllQuotas();

Bun.serve({
  port: 3000,
  hostname: "0.0.0.0",
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const cleanPath = url.pathname.replace(/\/+/g, "/");
    console.log(`[${new Date().toISOString()}] ${req.method} ${cleanPath} - Agent: ${req.headers.get("user-agent")}`);

    if (req.method === "OPTIONS") {
        return new Response(null, {
            headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
                "Access-Control-Allow-Headers": "*",
                "Access-Control-Max-Age": "86400",
            }
        });
    }

    const handler = findHandler(cleanPath, req.method);
    if (handler) {
        const provider = getDefaultProvider();
        const clientId = req.headers.get("x-client-id") || url.searchParams.get("client_id") || "unknown";
        let previewBody: any = {};

        if (req.method !== "GET") {
            try {
                previewBody = await req.clone().json();
            } catch {
                previewBody = {};
            }
        }

        const resolvedModel = resolveModel(String(previewBody.model || "antigravity:models"));
        const sessionId = buildSessionId(previewBody, clientId);
        return handler.handle({
            req,
            url,
            protocol: "openai",
            resolvedModel,
            provider,
            sessionId,
            clientId,
        });
    }

    if (cleanPath === "/oauth/start") {
      return Response.redirect(generateAuthUrl());
    }

    if (cleanPath === "/v1/models") {
        const models = Array.from(supportedModelsCache).sort().map(id => ({
            id,
            object: "model",
            created: Math.floor(Date.now() / 1000),
            owned_by: "antigravity"
        }));

        return new Response(JSON.stringify({
            object: "list",
            data: models
        }), { headers: { 
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "*"
        } });
    }

    if (url.pathname === "/api/sse") {
        let onUpdate: (data: any) => void;
        let onFlash: (data: { email: string, status: 'success' | 'error' }) => void;
        let onLog: (msg: string) => void;
        let onCooldown: (data: any) => void;

        const stream = new ReadableStream({
            start(controller) {
                const encoder = new TextEncoder();
                
                const send = (event: string, data: any) => {
                    try {
                        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
                    } catch (e) {
                    }
                };

                send("init", {
                    version: APP_VERSION,
                    accounts: getAccounts(),
                    strategy: getStrategy(),
                    supportedModels: Array.from(supportedModelsCache).sort(),
                    cooldowns: getCooldowns(),
                    logs: logBuffer
                });

                onUpdate = (data: any) => send("update", { ...data, supportedModels: Array.from(supportedModelsCache).sort() });
                onFlash = (data: { email: string, status: 'success' | 'error' }) => send("flash", data);
                onLog = (msg: string) => send("log", { message: msg });
                onCooldown = (data: any) => send("cooldown", data);

                eventBus.on("update", onUpdate);
                eventBus.on("flash", onFlash);
                eventBus.on("log", onLog);
                eventBus.on("cooldown", onCooldown);
            },
            cancel() {
                if (onUpdate) eventBus.off("update", onUpdate);
                if (onFlash) eventBus.off("flash", onFlash);
                if (onLog) eventBus.off("log", onLog);
                if (onCooldown) eventBus.off("cooldown", onCooldown);
            }
        });

        return new Response(stream, {
            headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "Access-Control-Allow-Origin": "*"
            }
        });
    }

    if (url.pathname === "/api/status") {
        return new Response(JSON.stringify({
            version: APP_VERSION,
            accounts: getAccounts(),
            strategy: getStrategy(),
            supportedModels: Array.from(supportedModelsCache).sort()
        }), { headers: { "Content-Type": "application/json" } });
    }

    if (url.pathname === "/api/strategy" && req.method === "POST") {
        const body = await req.json() as any;
        if (body.strategy) {
             setStrategy(body.strategy as SelectionStrategy);
             await updateProxyConfig({ rotation: { ...getProxyConfig().rotation, strategy: body.strategy } });
             return new Response("OK", { status: 200 });
        }
        return new Response("Missing strategy", { status: 400 });
    }

    if (url.pathname === "/api/config" && req.method === "GET") {
        return new Response(JSON.stringify(getProxyConfig()), { 
            headers: { 
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*"
            } 
        });
    }

    if (url.pathname === "/api/config" && req.method === "POST") {
        const body = await req.json() as any;
        try {
            const updated = await updateProxyConfig(body);
            return new Response(JSON.stringify(updated), { 
                headers: { 
                    "Content-Type": "application/json",
                    "Access-Control-Allow-Origin": "*"
                } 
            });
        } catch (e: any) {
            return new Response(JSON.stringify({ error: e.message }), { 
                status: 400,
                headers: { 
                    "Content-Type": "application/json",
                    "Access-Control-Allow-Origin": "*"
                }
            });
        }
    }

    if (url.pathname === "/api/accounts/reset-all" && req.method === "POST") {
        const accounts = getAccounts();
        for (const acc of accounts) {
            acc.healthScore = 100;
            acc.consecutiveFailures = 0;
            acc.cooldowns = {};
            acc.modelScores = {};
            acc.history = [];
            acc.quota = [];
            delete acc.challenge;
        }
        
        resetAllCooldowns();
        
        await saveAccounts(accounts);
        console.log(`[Manager] Reset state for all ${accounts.length} accounts via API`);
        return new Response("OK", { status: 200 });
    }

    if (url.pathname.startsWith("/api/accounts/") && req.method === "DELETE") {
        const email = url.pathname.replace("/api/accounts/", "");
        if (email) {
            await removeAccount(email);
            return new Response("OK", { status: 200 });
        }
        return new Response("Bad Request", { status: 400 });
    }

    if (url.pathname.startsWith("/api/accounts/") && url.pathname.endsWith("/reset") && req.method === "POST") {
        const email = url.pathname.split("/")[3];
        await resetAccount(email);
        return new Response("OK", { status: 200 });
    }

    if (url.pathname.startsWith("/api/accounts/") && url.pathname.endsWith("/project/rediscover") && req.method === "POST") {
        const email = url.pathname.split("/")[3];
        const accounts = getAccounts();
        const account = accounts.find(a => a.email === email);
        if (account && account.accessToken) {
            try {
                const newProjectId = await getProjectId(account.accessToken);
                if (newProjectId) {
                    await updateAccountProject(email, newProjectId);
                    return new Response(JSON.stringify({ projectId: newProjectId }), { status: 200 });
                }
                return new Response("No project found via discovery", { status: 404 });
            } catch (e: any) {
                return new Response(e.message, { status: 500 });
            }
        }
        return new Response("Account not found or no token", { status: 400 });
    }

    if (url.pathname.startsWith("/api/accounts/") && url.pathname.endsWith("/project") && req.method === "POST") {
        const email = url.pathname.split("/")[3];
        const body = await req.json() as any;
        if (body.projectId) {
            await updateAccountProject(email, body.projectId);
            return new Response("OK", { status: 200 });
        }
        return new Response("Missing projectId", { status: 400 });
    }

    if (url.pathname.startsWith("/api/accounts/") && url.pathname.endsWith("/cooldown") && req.method === "POST") {
        const email = url.pathname.split("/")[3];
        const body = await req.json() as any;
        const pool = body.pool || 'cli';
        markCooldown(email, pool as any, "3600s");
        return new Response("OK", { status: 200 });
    }

    if (url.pathname === "/oauth-callback") {
      const code = url.searchParams.get("code");
      if (!code) return new Response("Missing code", { status: 400 });

      try {
          const tokenRes = await exchangeCode(code);
          const email = await getUserEmail(tokenRes.access_token);
          const projectId = await getProjectId(tokenRes.access_token);

          const newAccount: AntigravityAccount = {
            email,
            refreshToken: tokenRes.refresh_token!,
            accessToken: tokenRes.access_token,
            expiresAt: Date.now() + (tokenRes.expires_in * 1000),
            projectId,
            healthScore: 100,
            lastUsed: 0,
            tokenUsage: 0
          };

          if (!newAccount.refreshToken) {
              return new Response("No refresh token received. Revoke access and try again.", { status: 400 });
          }

          if (newAccount.projectId) {
              const quota = await fetchQuota(newAccount);
              if (quota) {
                  newAccount.quota = quota;
              }
          }

          await addAccount(newAccount);
          
          return Response.redirect(`http://localhost:3000/frontend/index.html`);
      } catch (e) {
          return new Response(`Auth error: ${e}`, { status: 500 });
      }
    }

    if (url.pathname.startsWith("/frontend/")) {
        const path = url.pathname.replace("/frontend/", "");
        try {
            const file = Bun.file(`${import.meta.dir}/frontend/${path}`);
            return new Response(file);
        } catch {
            return new Response("Not Found", { status: 404 });
        }
    }
    
    if (url.pathname === "/") {
        return Response.redirect("/frontend/index.html");
    }

    return new Response("Not Found", { status: 404 });
  }
});

console.log("Antigravity Proxy running on http://127.0.0.1:3000");
