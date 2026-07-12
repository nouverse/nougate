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
import { AntigravityExecutor } from "./providers/antigravity/upstream/executor";
import { getModelSpec } from "./providers/antigravity/config/model-specs";
import { resolveModel } from "./core/model-resolver";
import { transformToGoogleBody, createOpenAIStreamTransformer } from "./utils/transform";

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

const proxyConfig = getProxyConfig();

setInterval(refreshAllQuotas, proxyConfig.quota.refreshIntervalMs);
// Initial quota refresh on startup
refreshAllQuotas();

/**
 * Normalize legacy model IDs so phase 1.5 can resolve an `IModelSpec`
 * before the mapper extraction in phase 1.6 removes this compatibility.
 */
function normalizeModelIdForPhase15(rawModel: string): string {
    let cleanId = (rawModel || "").trim().toLowerCase();
    cleanId = cleanId.replace(/^(openai|antigravity|custom_openai|litellm|google)\//i, "");
    cleanId = cleanId.replace(/^antigravity-/i, "");
    cleanId = cleanId.replace(/^gemini-claude-/i, "claude-");
    return cleanId;
}

/**
 * Resolve the best-effort provider-local model spec for the legacy OpenAI route.
 */
function resolveModelSpecForPhase15(rawModel: string) {
    const resolved = resolveModel(rawModel || "");
    const candidates = [
        resolved.modelId,
        normalizeModelIdForPhase15(resolved.modelId),
        normalizeModelIdForPhase15(rawModel || ""),
    ].filter(Boolean);

    for (const candidate of candidates) {
        const modelSpec = getModelSpec(candidate);
        if (modelSpec) {
            return modelSpec;
        }
    }

    return null;
}

/**
 * Convert a successful Google upstream response into the current OpenAI response shape.
 */
async function finalizeOpenAIResponse(params: {
    googleRes: Response;
    openaiBody: any;
    requestId: string;
    sessionId: string;
    attempts: number;
    accountEmail: string;
}) {
    const { googleRes, openaiBody, requestId, sessionId, attempts, accountEmail } = params;
    const decoder = new TextDecoder();
    const isStreaming = openaiBody.stream === true;

    if (isStreaming) {
        if (!googleRes.body) {
            return {
                response: new Response(JSON.stringify({ error: { message: "No response body from upstream" } }), {
                    status: 502,
                    headers: {
                        "Content-Type": "application/json",
                        "Access-Control-Allow-Origin": "*",
                        "X-Antigravity-Attempts": attempts.toString(),
                    },
                }),
            };
        }

        const stream = googleRes.body.pipeThrough(
            createOpenAIStreamTransformer(openaiBody.model, requestId, false, sessionId),
        );
        return {
            response: new Response(stream, {
                headers: {
                    "Content-Type": "text/event-stream",
                    "Cache-Control": "no-cache",
                    "Connection": "keep-alive",
                    "Access-Control-Allow-Origin": "*",
                    "X-Antigravity-Attempts": attempts.toString(),
                },
            }),
        };
    }

    if (!googleRes.body) {
        throw new Error("No response body");
    }

    const stream = googleRes.body.pipeThrough(
        createOpenAIStreamTransformer(openaiBody.model, requestId, false, sessionId),
    );
    const reader = stream.getReader();
    let fullContent = "";
    let reasoningContent = "";
    let aggregatedToolCalls: any[] = [];
    let finalFinishReason = "stop";
    let buffer = "";

    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
            if (line.startsWith("data: ") && line !== "data: [DONE]") {
                try {
                    const event = JSON.parse(line.slice(6));
                    if (event.choices?.[0]) {
                        const choice = event.choices[0];
                        if (choice.delta?.content) fullContent += choice.delta.content;
                        if (choice.delta?.reasoning_content) reasoningContent += choice.delta.reasoning_content;
                        if (choice.delta?.tool_calls) aggregatedToolCalls.push(...choice.delta.tool_calls);
                        if (choice.finish_reason) finalFinishReason = choice.finish_reason;
                    }
                } catch (error) {
                    console.warn("[Stream] Failed to parse non-streaming chunk:", error);
                }
            }
        }
    }

    if (buffer.startsWith("data: ") && buffer !== "data: [DONE]") {
        try {
            const event = JSON.parse(buffer.slice(6));
            if (event.choices?.[0]) {
                const choice = event.choices[0];
                if (choice.delta?.content) fullContent += choice.delta.content;
                if (choice.delta?.reasoning_content) reasoningContent += choice.delta.reasoning_content;
                if (choice.delta?.tool_calls) aggregatedToolCalls.push(...choice.delta.tool_calls);
                if (choice.finish_reason) finalFinishReason = choice.finish_reason;
            }
        } catch (error) {
            console.warn("[Stream] Failed to parse final non-streaming chunk:", error);
        }
    }

    if (!fullContent && aggregatedToolCalls.length === 0 && finalFinishReason !== "length") {
        console.warn(
            `[Empty] Account ${accountEmail} returned empty response for ${openaiBody.model}, retrying with another account...`,
        );
        return {
            retry: true as const,
            cooldownDuration: "30s",
        };
    }

    const finalResponse = {
        id: requestId,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: openaiBody.model,
        choices: [{
            index: 0,
            message: {
                role: "assistant",
                content: fullContent,
                reasoning_content: reasoningContent || undefined,
                tool_calls: aggregatedToolCalls.length > 0 ? aggregatedToolCalls : undefined,
            },
            finish_reason: finalFinishReason,
        }],
    };

    return {
        response: new Response(JSON.stringify(finalResponse), {
            headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
                "X-Antigravity-Attempts": attempts.toString(),
            },
        }),
    };
}

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

    if (cleanPath === "/v1/chat/completions" && req.method === "POST") {
      const openaiBody = await req.json() as any;
      const requestId = "chatcmpl-" + Math.random().toString(36).substring(7);
      const modelSpec = resolveModelSpecForPhase15(openaiBody.model);

      if (!modelSpec) {
          return new Response(JSON.stringify({
              error: {
                  message: `Unknown model "${openaiBody.model}"`,
                  type: "invalid_request_error",
                  code: "model_not_found",
              },
          }), {
              status: 400,
              headers: {
                  "Content-Type": "application/json",
                  "Access-Control-Allow-Origin": "*",
              },
          });
      }

      const clientId = req.headers.get("x-client-id") || url.searchParams.get("client_id") || "unknown";
      const firstMsg = openaiBody.messages?.[0]?.content || "";
      const userIdent = openaiBody.user || clientId;
      const stableSeed = `${userIdent}:${typeof firstMsg === 'string' ? firstMsg : JSON.stringify(firstMsg)}`;
      const sessionId = firstMsg ? new Bun.CryptoHasher("sha256").update(stableSeed).digest("hex") : crypto.randomUUID();
      const executor = new AntigravityExecutor();
      const result = await executor.execute({
          model: openaiBody.model,
          modelSpec,
          sessionId,
          clientId,
          debugRequestBody: openaiBody,
          buildGoogleBody: ({ useCliPool, aggressive }) =>
              transformToGoogleBody(openaiBody, "", useCliPool, "", sessionId, aggressive),
          handleSuccess: async ({ googleRes, account, attempts }) =>
              finalizeOpenAIResponse({
                  googleRes,
                  openaiBody,
                  requestId,
                  sessionId,
                  attempts,
                  accountEmail: account.email,
              }),
      });

      return result.response;
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
