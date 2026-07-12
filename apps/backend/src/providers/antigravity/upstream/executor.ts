import type { UpstreamExecuteOptions, UpstreamResult } from "../../../core/interfaces";
import { getProxyConfig } from "../../../config/manager";
import { getAntigravityConfig } from "../provider-config";
import {
  emitAccountFlash,
  ensureFingerprint,
  flagAccountChallenge,
  flagModelUnsupported,
  getAccounts,
  getEarliestReset,
  getFamilyName,
  getBestAccount,
  markCooldown,
  updateAccountUsage,
} from "../auth/manager";
import type { AntigravityAccount } from "../auth/types";
import { parseGoogleError } from "./errors";
import { getGeminiCliHeaders, getImpersonationHeaders } from "./headers";

/**
 * Parameters used to rebuild a Google request body for the current attempt.
 */
interface BuildGoogleBodyParams {
  useCliPool: boolean;
  aggressive: boolean;
}

/**
 * Context exposed to the route-specific success handler after upstream succeeds.
 */
interface ExecuteSuccessParams {
  googleRes: Response;
  account: AntigravityAccount;
  attempts: number;
  useCliPool: boolean;
}

/**
 * Success handler output. It can either finalize the response or request a retry.
 */
type ExecuteSuccessResult =
  | { response: Response; retry?: false }
  | { retry: true; cooldownDuration?: string };

/**
 * Executor options used by the current legacy OpenAI route during phase 1.5.
 */
type AntigravityExecuteOptions = Omit<UpstreamExecuteOptions, "googleBody" | "provider"> & {
  buildGoogleBody: (params: BuildGoogleBodyParams) => any;
  handleSuccess: (params: ExecuteSuccessParams) => Promise<ExecuteSuccessResult>;
  debugRequestBody?: any;
};

/**
 * Build a JSON response with the standard proxy headers for OpenAI clients.
 */
function createJsonResponse(body: unknown, status: number, attempts: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "X-Antigravity-Attempts": attempts.toString(),
    },
  });
}

/**
 * Pick the correct upstream endpoint for the current pool and attempt.
 */
function selectGoogleUrl(
  endpoints: { sandbox: string[]; cli: string[] },
  useCliPool: boolean,
  attempts: number,
  isClaudeModel: boolean,
): string {
  if (useCliPool) {
    const index = isClaudeModel
      ? endpoints.cli.length - 1
      : Math.min(attempts - 1, endpoints.cli.length - 1);
    return endpoints.cli[index];
  }

  const index = Math.min(attempts - 1, endpoints.sandbox.length - 1);
  return endpoints.sandbox[index];
}

/**
 * Parse quota reset information from a Google error payload when present.
 */
function parseQuotaResetSeconds(errorText: string): number {
  try {
    const errorJson = JSON.parse(errorText);
    const details = errorJson.error?.details || [];

    for (const detail of details) {
      if (detail.metadata?.quotaResetDelay) {
        return parseFloat(detail.metadata.quotaResetDelay);
      }
      if (detail.retryDelay) {
        return parseFloat(detail.retryDelay);
      }
    }

    if (errorJson.error?.message?.includes("reset after")) {
      const match = errorJson.error.message.match(/reset after\s+([0-9.]+)s/);
      if (match) {
        return parseFloat(match[1]);
      }
    }
  } catch {}

  return 0;
}

/**
 * Check whether a Google 400 response is the known schema-cleaning retry case.
 */
function isSchemaCleaningError(errorText: string): boolean {
  const lower = errorText.toLowerCase();
  return (
    lower.includes("tool schema") ||
    errorText.includes("Invalid JSON payload") ||
    lower.includes("function_declarations")
  );
}

/**
 * Emit the detailed 400 debugging logs preserved from the legacy route.
 */
function logDebug400(debugRequestBody: any, googleBody: any): void {
  const incomingMessages = debugRequestBody?.messages || [];
  console.error(`[Debug-400-IN] Incoming from client: ${incomingMessages.length} messages`);

  for (let index = 0; index < incomingMessages.length; index++) {
    const message = incomingMessages[index];
    if (message.role === "tool") {
      console.error(
        `[Debug-400-IN] msg[${index}] role=tool, name=${message.name}, tool_call_id=${message.tool_call_id}`,
      );
      continue;
    }

    if (message.tool_calls) {
      const toolSummary = message.tool_calls
        .map((toolCall: any) => `${toolCall.function?.name}(id=${toolCall.id})`)
        .join(", ");
      console.error(
        `[Debug-400-IN] msg[${index}] role=${message.role}, tool_calls=[${toolSummary}], has_thought=${!!message.thought}, has_reasoning=${!!message.reasoning_content}`,
      );
      continue;
    }

    const contentLength =
      typeof message.content === "string"
        ? message.content.length
        : JSON.stringify(message.content || "").length;
    console.error(
      `[Debug-400-IN] msg[${index}] role=${message.role}, content_len=${contentLength}`,
    );
  }

  const requestContents = googleBody.request?.contents || [];
  console.error(
    `[Debug-400-OUT] Outgoing to Google: model=${googleBody.model} | ${requestContents.length} contents`,
  );

  for (let index = 0; index < requestContents.length; index++) {
    const content = requestContents[index];
    const partSummaries = (content.parts || []).map((part: any, partIndex: number) => {
      if (part.functionCall) {
        return `[${partIndex}] functionCall(${part.functionCall.name}, id=${part.functionCall.id || "none"}, hasSig=${!!part.thoughtSignature})`;
      }
      if (part.functionResponse) {
        return `[${partIndex}] functionResponse(${part.functionResponse.name})`;
      }
      if (part.thought) {
        return `[${partIndex}] thought(hasSig=${!!part.thoughtSignature}, len=${(part.text || "").length})`;
      }
      if (part.text) {
        return `[${partIndex}] text(len=${part.text.length})`;
      }
      return `[${partIndex}] other`;
    });
    console.error(
      `[Debug-400-OUT] contents[${index}] role=${content.role}: ${partSummaries.join(" | ")}`,
    );
  }

  console.error(
    `[Debug-400-OUT] thinkingConfig: ${JSON.stringify(
      googleBody.request?.generationConfig?.thinkingConfig,
    )}`,
  );
}

/**
 * Antigravity upstream executor extracted from the legacy server route.
 */
export class AntigravityExecutor {
  /**
   * Execute one upstream request with account rotation, retries, and error handling.
   */
  async execute(options: AntigravityExecuteOptions): Promise<UpstreamResult> {
    const proxyConfig = getProxyConfig();
    const providerConfig = getAntigravityConfig();
    const maxAttempts = Math.max(proxyConfig.retry.maxAttempts, getAccounts().length);
    const modelId = options.modelSpec.modelId;
    const isClaudeModel =
      modelId.toLowerCase().includes("claude") ||
      (options.modelSpec.upstreamModelId || "").toLowerCase().includes("claude");
    const endpoints = {
      sandbox: providerConfig.endpoints.sandbox,
      cli: providerConfig.endpoints.cli,
    };

    let attempts = 0;
    let aggressive = false;
    let useCliPool = options.modelSpec.useCliPool ?? options.modelSpec.pool === "cli";
    let lastStatus = 0;
    let originAccountEmail = "";
    let systemicErrorCount = 0;
    const triedEmails: string[] = [];
    const attemptLogs: Array<{ email: string; status: number; reason: string }> = [];

    while (attempts < maxAttempts) {
      attempts++;

      if (attempts > 1) {
        const delayMs = Math.min(500 * attempts, 3000);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        console.log(
          `[Switch] Skipping pool switch for ${useCliPool ? "CLI-only" : "sandbox-only"} model (attempt ${attempts})`,
        );
      }

      const pool = useCliPool ? "cli" : "sandbox";
      let account = await getBestAccount(pool, modelId, options.clientId, triedEmails, true);

      if (!account) {
        account = await getBestAccount(pool, modelId, options.clientId, triedEmails, false);
      }

      if (!account || !account.accessToken) {
        if (attempts < maxAttempts) {
          console.log(`[Switch] Exhausted all accounts in ${pool} pool, retrying...`);
          triedEmails.length = 0;
          continue;
        }
        break;
      }

      const googleUrl = selectGoogleUrl(endpoints, useCliPool, attempts, isClaudeModel);
      if (lastStatus === 503) {
        console.log(
          `[Capacity] Retrying account ${account.email} on next endpoint ${googleUrl.split("/")[2]}...`,
        );
      } else {
        triedEmails.push(account.email);
      }

      if (isClaudeModel && !googleUrl.includes("v1internal")) {
        console.warn(
          `[Warning] Claude model ${options.model} is being routed to a non-v1internal endpoint: ${googleUrl}`,
        );
      }

      ensureFingerprint(account);
      const googleBody = options.buildGoogleBody({ useCliPool, aggressive });
      const payload = {
        ...googleBody,
        request: {
          ...googleBody.request,
        },
        project: account.projectId,
      };

      if (attempts === 1) {
        originAccountEmail = account.email;
      } else if (originAccountEmail && originAccountEmail !== account.email) {
        console.log(
          `[Signature] Retrying with different account (${account.email}), keeping signatures intact`,
        );
      }

      const isClaudeTarget = String(googleBody.model || "").toLowerCase().includes("claude");
      const headers =
        useCliPool && !isClaudeTarget
          ? getGeminiCliHeaders(account.accessToken, account.fingerprint!)
          : getImpersonationHeaders(account.accessToken, account.fingerprint!, googleBody.model);

      console.log(
        `[Request] Model: ${options.model} | Account: ${account.email} | Project: ${account.projectId} | Attempt: ${attempts}/${maxAttempts} | Pool: ${pool === "cli" ? "CLI" : "Sandbox"} | Endpoint: ${googleUrl.split("/")[2]} | Target Model: ${googleBody.model}`,
      );

      const timeoutMs = options.modelSpec.timeoutMs ?? 60000;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        if (providerConfig.features.jitterEnabled) {
          const jitterMs =
            providerConfig.features.jitterMinMs +
            Math.random() * (providerConfig.features.jitterMaxMs - providerConfig.features.jitterMinMs);
          await new Promise((resolve) => setTimeout(resolve, jitterMs));
        }

        const googleRes = await fetch(googleUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (!googleRes.ok) {
          const errText = await googleRes.text();
          const parsedError = parseGoogleError(errText);
          const status = googleRes.status;
          lastStatus = status;

          console.error(
            `[Error] Google API (${account.email}) returned ${status} (${parsedError.reason}):`,
            errText,
          );

          if (status === 400) {
            logDebug400(options.debugRequestBody, googleBody);
          }

          emitAccountFlash(account.email, "error");
          attemptLogs.push({ email: account.email, status, reason: parsedError.reason });

          if (status === 403 || status === 404) {
            const familyName = getFamilyName(modelId);
            if (parsedError.isChallengeRequired) {
              console.log(
                `[Auth] ${parsedError.reason} for ${account.email}, flagging pool ${pool} for family ${familyName}.`,
              );
              flagAccountChallenge(account.email, pool, familyName, {
                type: "CAPTCHA",
                url:
                  parsedError.validationUrl ||
                  "https://cloud.google.com/gemini/docs/codeassist/request-license",
                reason: parsedError.reason,
                message: parsedError.message,
              });
              continue;
            }

            if (parsedError.isModelUnsupported) {
              console.log(`[Model] Unsupported model ${modelId} for ${account.email}, marking capability.`);
              flagModelUnsupported(account.email, modelId);
            }

            await updateAccountUsage(account.email, false, modelId, pool, options.clientId, status);
            return {
              response: createJsonResponse(
                {
                  error: {
                    message: `Access denied: ${parsedError.reason}`,
                    type: "access_denied",
                    code: status.toString(),
                  },
                },
                status,
                attempts,
              ),
              accountId: account.email,
              attempts,
            };
          }

          if (status === 500 || status === 503) {
            systemicErrorCount++;
            if (systemicErrorCount > 2) {
              console.log(
                `[Systemic] Detected systemic outage (${systemicErrorCount} errors), breaking retry loop.`,
              );
              break;
            }
          }

          const resetSeconds = parseQuotaResetSeconds(errText);
          if (
            status === 429 &&
            resetSeconds > 0 &&
            resetSeconds <= proxyConfig.retry.transientRetryThresholdSeconds
          ) {
            console.log(
              `[Skip] Account ${account.email} transiently limited (${resetSeconds}s), rotating...`,
            );
            account.consecutiveFailures = (account.consecutiveFailures || 0) + 1;
            if ((account.consecutiveFailures || 0) >= 2) {
              await updateAccountUsage(account.email, false, modelId, pool, options.clientId, 429);
            }
            triedEmails.push(account.email);
            continue;
          }

          if (status === 400 && errText.includes("thought_signature")) {
            console.error(
              "[Signature] Fatal: thought_signature error persists after text summarization fallback. Breaking retry loop.",
            );
            await updateAccountUsage(account.email, false, modelId, pool, options.clientId, status);
            return {
              response: createJsonResponse(
                {
                  error: {
                    message:
                      "This conversation contains function calls without thought signatures. Please start a new conversation or clear the conversation history to resolve this.",
                    type: "invalid_request_error",
                    code: "thought_signature_missing",
                  },
                },
                400,
                attempts,
              ),
              accountId: account.email,
              attempts,
            };
          }

          if (status === 400 && isSchemaCleaningError(errText) && !aggressive) {
            console.log(
              `[Schema] Detected tool schema error for ${account.email}, retrying with aggressive cleaning...`,
            );
            aggressive = true;
            attempts--;
            continue;
          }

          aggressive = false;
          await updateAccountUsage(account.email, false, modelId, pool, options.clientId, status);
          if (status === 429) {
            markCooldown(account.email, pool, getFamilyName(modelId));
          }
          continue;
        }

        const success = await options.handleSuccess({
          googleRes,
          account,
          attempts,
          useCliPool,
        });

        if (success.retry) {
          if (success.cooldownDuration) {
            markCooldown(account.email, pool, getFamilyName(modelId), success.cooldownDuration);
          }
          aggressive = false;
          continue;
        }

        await updateAccountUsage(account.email, true, modelId, pool, options.clientId);
        emitAccountFlash(account.email, "success");
        return {
          response: success.response,
          accountId: account.email,
          attempts,
        };
      } catch (error: any) {
        clearTimeout(timeoutId);
        if (error.name === "AbortError") {
          console.error(`[Timeout] Request timed out for ${account.email} after ${timeoutMs}ms`);
          account.healthScore = Math.max(
            proxyConfig.scoring.healthRange.min,
            account.healthScore - 5,
          );
        } else {
          console.error(`Proxy error for ${account.email}:`, error);
        }

        await updateAccountUsage(account.email, false, modelId, pool, options.clientId);
        attemptLogs.push({ email: account.email || "unknown", status: 500, reason: error.message });

        if (attempts < maxAttempts) {
          continue;
        }

        return {
          response: createJsonResponse(
            { error: { message: `Proxy exception: ${error.message}` } },
            500,
            attempts,
          ),
          accountId: account.email,
          attempts,
        };
      }
    }

    const resetTime = getEarliestReset(useCliPool ? "cli" : "sandbox");
    const resetMessage = resetTime ? ` Next reset in ${resetTime}.` : "";
    return {
      response: createJsonResponse(
        {
          error: {
            message: `Quota Exhausted: All accounts failed or are exhausted for this model.${resetMessage} Try a different model or wait for quota reset.`,
            type: "insufficient_quota",
            code: "insufficient_quota",
            attempts: attemptLogs,
          },
        },
        429,
        attempts,
      ),
      accountId: "",
      attempts,
    };
  }
}
