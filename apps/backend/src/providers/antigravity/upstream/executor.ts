import type { UpstreamExecuteOptions, UpstreamResult } from "@/core/interfaces";
import { getProxyConfig } from "@/config/manager";
import {
  emitAccountFlash,
  ensureFingerprint,
  flagAccountChallenge,
  flagModelUnsupported,
  getAccounts,
  getEarliestReset,
  getFamilyName,
  getBestAccount,
  cooldownScope,
  markCooldown,
  updateAccountUsage,
} from "@/providers/antigravity/auth/manager";
import type { AntigravityAccount } from "@/providers/antigravity/auth/types";
import {
  ANTIGRAVITY_ENDPOINTS,
  type AntigravityEndpoints,
} from "@/providers/antigravity/upstream/endpoints";
import { parseGoogleError } from "@/providers/antigravity/upstream/errors";
import { getGeminiCliHeaders, getImpersonationHeaders } from "@/providers/antigravity/upstream/headers";
import { parseRetryDelay } from "@/providers/antigravity/utils/retry";

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
 * The pause before trying the next account, in milliseconds.
 *
 * Short, and random so that it is not a constant. The next account has not been
 * limited by this one's failure, and the request was already spaced by the jitter
 * before its first attempt. The sleep here used to grow by half a second per
 * attempt up to three, so a request that probed accounts lacking its model spent
 * half a minute asleep — that was the slow rotation. Waiting on the *same* account
 * after a short 429 is the grace retry below, and keeps its own delay.
 */
export function nextAccountGapMs(): number {
  return 150 + Math.random() * 300;
}

/**
 * Build a JSON response with the standard proxy headers for OpenAI clients.
 */
export interface ExhaustionInput {
  model: string;
  /** How many accounts actually returned something. */
  attemptCount: number;
  attemptLogs: Array<{ email: string; status: number; reason: string }>;
  /** Accounts that answered "this model does not exist here". */
  unsupportedCount: number;
  /** 5xx replies counted across accounts. */
  systemicErrorCount: number;
  lastStatus: number;
  /** Human countdown to the next quota reset, when known. */
  resetTime: string | null;
}

/**
 * Decide what to tell the client when every account has been tried.
 *
 * "All accounts failed" has three quite different causes, and they used to
 * share one answer: 429 `insufficient_quota`. That told clients to back off for
 * a quota window when the real problem was a Google outage, and recorded an
 * upstream failure in our own metrics as our quota running out.
 */
export function summarizeExhaustion(input: ExhaustionInput): { status: number; body: unknown } {
  const { attemptLogs } = input;

  // Nobody has the model. Rotating further would not help, and a quota message
  // sends the operator hunting for a limit that is not the problem.
  if (input.unsupportedCount > 0 && input.unsupportedCount >= input.attemptCount) {
    return {
      status: 404,
      body: {
        error: {
          message: `No account has access to "${input.model}". It may not be rolled out to your accounts yet.`,
          type: "invalid_request_error",
          code: "model_not_found",
          attempts: attemptLogs,
        },
      },
    };
  }

  // The upstream is broken, not exhausted. 503 is retryable in a way 429 is not.
  if (input.systemicErrorCount > 0 && input.lastStatus >= 500) {
    return {
      status: 503,
      body: {
        error: {
          message: `The upstream is failing (${input.systemicErrorCount} server errors across accounts). This is not a quota problem — retry shortly.`,
          type: "upstream_error",
          code: "upstream_unavailable",
          attempts: attemptLogs,
        },
      },
    };
  }

  const resetMessage = input.resetTime ? ` Next reset in ${input.resetTime}.` : "";
  return {
    status: 429,
    body: {
      error: {
        message: `Quota Exhausted: All accounts failed or are exhausted for this model.${resetMessage} Try a different model or wait for quota reset.`,
        type: "insufficient_quota",
        code: "insufficient_quota",
        attempts: attemptLogs,
      },
    },
  };
}

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
  endpoints: AntigravityEndpoints,
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

// parseQuotaResetSeconds removed in favor of utils/retry's parseRetryDelay

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
    const maxAttempts = Math.max(proxyConfig.retry.maxAttempts, getAccounts().length);
    const modelId = options.modelSpec.modelId;
    const isClaudeModel =
      modelId.toLowerCase().includes("claude") ||
      (options.modelSpec.upstreamModelId || "").toLowerCase().includes("claude");
    const endpoints = ANTIGRAVITY_ENDPOINTS;

    let attempts = 0;
    let aggressive = false;
    let useCliPool = options.modelSpec.useCliPool ?? options.modelSpec.pool === "cli";
    let lastStatus = 0;
    let originAccountEmail = "";
    let systemicErrorCount = 0;
    let unsupportedCount = 0;
    const triedEmails: string[] = [];
    const attemptLogs: Array<{ email: string; status: number; reason: string }> = [];

    let account: AntigravityAccount | null = null;
    let inPlaceRetry = false;
    let graceRetries = 0;
    const maxGraceRetries = 3;
    let pool: "cli" | "sandbox" = useCliPool ? "cli" : "sandbox";

    while (attempts < maxAttempts) {
      if (!inPlaceRetry) {
        attempts++;
        graceRetries = 0;

        if (attempts > 1) {
          await new Promise((resolve) => setTimeout(resolve, nextAccountGapMs()));
          console.log(
            `[Switch] Skipping pool switch for ${useCliPool ? "CLI-only" : "sandbox-only"} model (attempt ${attempts})`,
          );
        }

        pool = useCliPool ? "cli" : "sandbox";
        account = await getBestAccount(pool, modelId, options.clientId, triedEmails, true);

        if (!account) {
          account = await getBestAccount(pool, modelId, options.clientId, triedEmails, false);
        }
      }

      inPlaceRetry = false;

      if (!account || !account.accessToken) {
          // Reset triedEmails once to give all accounts a second chance,
          // but only if we haven't already done a full second pass.
          if (triedEmails.length > 0 && attempts < maxAttempts) {
            console.log(`[Switch] Exhausted all accounts in ${pool} pool, retrying once from start...`);
            triedEmails.length = 0;
          } else {
            break;
          }
          continue;
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
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      try {
        // Jitter is applied once per request by `executeProviderRequest`, before
        // this executor is reached, so the floor an operator sets in
        // BOTTOM_JITTER cannot be reimplemented away here.
        timeoutId = setTimeout(() => controller.abort(), timeoutMs);

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
              // Antigravity rolls models out per account, so "not found here"
              // says nothing about the rest of the pool. Flag this one and try
              // the next — returning here failed the whole request even when
              // another account could have served it.
              console.log(`[Model] Unsupported model ${modelId} for ${account.email}, trying another account.`);
              flagModelUnsupported(account.email, modelId);
              unsupportedCount++;
              await updateAccountUsage(account.email, false, modelId, pool, options.clientId, status);
              triedEmails.push(account.email);
              continue;
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

          const resetMs = parseRetryDelay(errText);
          const resetSeconds = resetMs / 1000;

          if (status === 429) {
            if (resetMs > 0 && resetMs <= 2000 && graceRetries < maxGraceRetries) {
              const sleepMs = resetMs + 1500;
              graceRetries++;
              console.log(
                `[GraceRetry] Account ${account.email} transiently limited. Sleeping for ${sleepMs}ms and retrying in-place (${graceRetries}/${maxGraceRetries})...`,
              );
              await new Promise((resolve) => setTimeout(resolve, sleepMs));
              inPlaceRetry = true;
              continue;
            }

            if (
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
          }

          if (status === 400 && errText.includes("thought_signature")) {
            console.error(
              "[Signature] Fatal: upstream rejected the request over thought signatures even though every unsignable call carries the validation-skip placeholder. Breaking retry loop.",
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
            // Do NOT decrement attempts — we still consumed one attempt slot.
            // Just retry in-place with the same account and aggressive=true.
            inPlaceRetry = true;
            continue;
          }

          aggressive = false;
          await updateAccountUsage(account.email, false, modelId, pool, options.clientId, status);
          if (status === 429) {
            markCooldown(account.email, pool, cooldownScope(modelId), undefined, 'quota_exhausted');
          }
          // For non-retryable 400 errors (bad request that won't change across accounts), break immediately.
          if (status === 400) {
            console.error(`[Error] Non-retryable 400 error, breaking retry loop.`);
            return {
              response: createJsonResponse(
                {
                  error: {
                    message: `Bad request: ${parsedError.message || parsedError.reason}`,
                    type: "invalid_request_error",
                    code: "bad_request",
                  },
                },
                400,
                attempts,
              ),
              accountId: account.email,
              attempts,
            };
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
            markCooldown(account.email, pool, cooldownScope(modelId), success.cooldownDuration, 'quota_exhausted');
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

    const exhaustion = summarizeExhaustion({
      model: options.model,
      attemptCount: attemptLogs.length,
      attemptLogs,
      unsupportedCount,
      systemicErrorCount,
      lastStatus,
      resetTime: getEarliestReset(useCliPool ? "cli" : "sandbox"),
    });

    return {
      response: createJsonResponse(exhaustion.body, exhaustion.status, attempts),
      accountId: "",
      attempts,
    };
  }
}
