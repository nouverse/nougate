import type { IModelSpec, IProvider, ProviderExecuteParams } from '@/core/interfaces';
import { applyJitter } from '@/core/jitter';
import { reframedHeaders } from '@/core/response-framing';
import type { RoutingCandidate } from '@/core/smart-routing';
import { ModelUnavailableError, ProviderResponseError } from '@/core/upstream-errors';

/**
 * The one way a protocol handler reaches a provider.
 *
 * Everything that must happen to *every* upstream request, whoever serves it,
 * belongs here rather than in each provider's executor. Right now that is the
 * jitter delay: putting it here is what makes `BOTTOM_JITTER` an actual floor
 * instead of a suggestion each provider is free to reimplement or forget.
 *
 * The wait happens before `execute`, so a provider's own per-model timeout
 * starts counting after the delay rather than being eaten by it.
 *
 * `jitter: false` is for a failover: the request was spaced before its first
 * attempt, and the next provider carrying it on is the same request, not a new one.
 */
export async function executeProviderRequest(
  provider: IProvider,
  params: ProviderExecuteParams,
  options: { jitter?: boolean } = {},
): Promise<Response> {
  if (options.jitter !== false) await applyJitter(provider.getJitterConfig());
  return provider.execute(params);
}

/** Which candidate actually answered, so metrics and logs name the provider that served. */
export interface FailoverResult {
  response: Response;
  provider: IProvider;
  modelSpec: IModelSpec;
}

/**
 * The headers that tell a client who served its request, on every response a provider gave.
 *
 * A client asks for a model; a bare id can be served by any provider that has it, the next one taking over when
 * the first fails, and the body's `model` does not say which did on every provider. So the response says it, the
 * same way whoever served: the provider, the model as that provider names it, and how many providers were tried
 * for this request, the one that answered included. A client that keeps its own accounting (Nouride's
 * `llm_usage`) can then split it by what actually ran.
 */
export const SERVED_HEADERS = ['x-nougate-provider', 'x-nougate-model', 'x-nougate-attempts'] as const;

function served(result: FailoverResult, attempts: number): FailoverResult {
  // Reframed: a provider may hand back the upstream's own response, whose encoding the body no longer has.
  const headers = reframedHeaders(result.response);
  headers.set('x-nougate-provider', result.provider.id);
  headers.set('x-nougate-model', result.modelSpec.modelId);
  headers.set('x-nougate-attempts', String(attempts));
  const { status, statusText } = result.response;
  return { ...result, response: new Response(result.response.body, { status, statusText, headers }) };
}

/**
 * Statuses that mean "this request will fail the same way everywhere".
 *
 * A malformed body is malformed for every provider, so trying the next one spends latency to reach
 * the same answer while burying the reason under "all providers failed". Everything else — a spent
 * quota, dead credentials, an upstream having a bad day — is exactly what a second provider is for.
 */
const UNIVERSALLY_FATAL = new Set([400, 413, 422]);

function worthAnotherProvider(status: number): boolean {
  return !UNIVERSALLY_FATAL.has(status);
}

/**
 * Try each candidate in turn until one answers.
 *
 * ## Failing over is safe here, and only here
 *
 * Nothing has been written to the client socket while this runs: the handler still holds the
 * `Response` object and has not returned it. That is what makes discarding a 429 and trying the next
 * provider legitimate even for a stream — the body has not started flowing to anyone. Once this
 * function returns, that stops being true, so no retry may ever be added downstream of it.
 *
 * ## Two shapes of failure, because providers disagree about which to use
 *
 * Some throw when they give up (Claude Code, Codex); Antigravity returns a 429 with an `attempts`
 * array in the body. Only checking for a throw is what made an exhausted Antigravity quota return
 * "Quota Exhausted" to the caller while a perfectly healthy Claude Code account sat unused. Both
 * shapes are read the same way, through the status.
 *
 * The first failure is the one handed back if every candidate fails: it comes from the provider the
 * operator ordered first, so the error a caller sees does not change depending on how far down the
 * list the fan-out happened to get.
 *
 * ## Spaced once
 *
 * The jitter is paid before the first candidate only. Each failover used to wait a whole window again,
 * so a request that met a spent quota cost two jitters and one that went three providers deep cost
 * three — the delay meant to make requests look unhurried was making failures slow.
 */
export async function executeWithFailover(
  candidates: RoutingCandidate[],
  buildParams: (candidate: RoutingCandidate) => ProviderExecuteParams,
): Promise<FailoverResult> {
  let firstFailure: FailoverResult | null = null;
  let lastError: unknown;

  for (const [index, candidate] of candidates.entries()) {
    const remaining = candidates.length - index - 1;
    const next = remaining > 0 ? `, trying ${candidates[index + 1]!.provider.id}` : '';

    try {
      const response = await executeProviderRequest(candidate.provider, buildParams(candidate), { jitter: index === 0 });
      const result = { response, provider: candidate.provider, modelSpec: candidate.modelSpec };

      if (response.ok || !worthAnotherProvider(response.status)) {
        if (index > 0 && response.ok) {
          console.log(
            `[Routing] ${candidate.modelSpec.modelId} served by ${candidate.provider.id} after ${index} provider(s) failed`,
          );
        }
        return served(result, index + 1);
      }

      console.warn(
        `[Routing] ${candidate.provider.id} answered ${response.status} for ${candidate.modelSpec.modelId}${next}`,
      );
      if (firstFailure === null) {
        firstFailure = result;
      } else {
        // Held responses keep a socket open; only the one that may still be returned is spared.
        void response.body?.cancel();
      }
    } catch (error) {
      const status = (error as { status?: number })?.status;
      if (typeof status === 'number' && !worthAnotherProvider(status)) {
        throw error;
      }

      lastError = error;
      console.warn(
        `[Routing] ${candidate.provider.id} could not serve ${candidate.modelSpec.modelId}${next}: ` +
          String((error as { message?: string })?.message ?? error).slice(0, 200),
      );
    }
  }

  if (firstFailure) return served(firstFailure, candidates.length);
  throw lastError ?? new Error('No provider could serve this request.');
}
