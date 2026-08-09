import type { IModelSpec } from '@/core/interfaces';
import { getProxyConfig } from '@/config/manager';
import { adminEventBus } from '@/core/events';
import { ProviderUnavailableError } from '@/core/upstream-errors';
import {
  type CustomProviderKeyRecord,
  type CustomProviderRecord,
  listProviderKeys,
  persistKeyState,
} from './store';

export interface CustomExecuteResult {
  response: Response;
  keyId: string;
  attempts: number;
}

export class NoUsableKeyError extends Error {
  constructor(providerId: string) {
    super(
      `No usable API key for custom provider "${providerId}". Add a key in the dashboard, or reset the ones in cooldown.`,
    );
    this.name = 'NoUsableKeyError';
  }
}

/**
 * Every key is serving out a rate-limit cooldown.
 *
 * Distinct from `NoUsableKeyError`, which means nothing is configured: this one
 * is temporary and carries the wait, so the caller can answer 429 with a
 * retry hint instead of a generic failure.
 */
export class AllKeysCoolingError extends ProviderUnavailableError {
  constructor(providerId: string, retryAfterMs: number) {
    const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
    super(
      `Every API key for "${providerId}" is rate limited. The first one frees up in ${seconds}s.`,
      429,
      seconds,
    );
    this.name = 'AllKeysCoolingError';
  }
}

/**
 * Build the upstream chat endpoint for a provider's API style.
 */
export function chatEndpoint(provider: CustomProviderRecord): string {
  return provider.apiStyle === 'anthropic'
    ? `${provider.baseUrl}/messages`
    : `${provider.baseUrl}/chat/completions`;
}

/**
 * Build the upstream model-listing endpoint for a provider's API style.
 */
export function modelsEndpoint(provider: CustomProviderRecord): string {
  return `${provider.baseUrl}/models`;
}

/**
 * Auth headers follow the convention of the selected API style: OpenAI uses a
 * Bearer token, Anthropic uses x-api-key plus an API version.
 */
export function buildHeaders(
  provider: CustomProviderRecord,
  apiKey: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...provider.extraHeaders,
  };

  if (provider.apiStyle === 'anthropic') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = provider.extraHeaders['anthropic-version'] || '2023-06-01';
  } else {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  return headers;
}

/**
 * Pick the healthiest key that is not in cooldown, breaking ties by least
 * recently used so traffic spreads across all of a provider's keys.
 */
function selectKey(
  keys: CustomProviderKeyRecord[],
  excludeIds: string[],
): CustomProviderKeyRecord | null {
  const now = Date.now();

  // A cooling key is genuinely unavailable. This used to fall back to using one
  // anyway "rather than failing the request outright" — which meant a provider
  // with a single key ignored its own cooldown completely and hammered an
  // upstream that had just asked us to slow down, the fastest way to earn a
  // longer ban.
  const candidates = keys.filter(
    (key) => !excludeIds.includes(key.id) && key.cooldownUntil <= now,
  );

  if (candidates.length === 0) {
    return null;
  }

  return candidates.reduce((best, key) => {
    if (key.healthScore !== best.healthScore) {
      return key.healthScore > best.healthScore ? key : best;
    }
    return key.lastUsed < best.lastUsed ? key : best;
  });
}

/** How long until the first key comes out of cooldown, or 0 if one is free. */
export function shortestCooldownMs(keys: CustomProviderKeyRecord[], now = Date.now()): number {
  if (keys.length === 0) {
    return 0;
  }
  return Math.max(0, Math.min(...keys.map((key) => key.cooldownUntil - now)));
}

function cooldownMs(): number {
  try {
    return getProxyConfig().rotation.cooldown.defaultDurationMs;
  } catch {
    return 60_000;
  }
}

async function penalize(key: CustomProviderKeyRecord, statusCode: number): Promise<void> {
  const config = (() => {
    try {
      return getProxyConfig().scoring;
    } catch {
      return null;
    }
  })();

  const penalty = statusCode === 401 || statusCode === 403
    ? config?.penalties.fatalError ?? -50
    : config?.penalties.apiError ?? -10;
  const min = config?.healthRange.min ?? 0;

  key.healthScore = Math.max(min, key.healthScore + penalty);
  key.consecutiveFailures += 1;

  // Only a rate limit earns a cooldown. A 503 is the upstream having a bad
  // moment; benching the key for a minute over one blip would take a
  // single-key provider offline for no reason.
  if (statusCode === 429) {
    key.cooldownUntil = Date.now() + cooldownMs();
  }

  await persistKeyState(key);
}

async function reward(key: CustomProviderKeyRecord): Promise<void> {
  const config = (() => {
    try {
      return getProxyConfig().scoring;
    } catch {
      return null;
    }
  })();

  const max = config?.healthRange.max ?? 100;
  key.healthScore = Math.min(max, key.healthScore + (config?.rewards.success ?? 1));
  key.consecutiveFailures = 0;
  key.lastUsed = Date.now();
  key.cooldownUntil = 0;

  await persistKeyState(key);
}

export interface CustomExecuteOptions {
  provider: CustomProviderRecord;
  body: any;
  modelSpec: IModelSpec;
  clientId?: string;
}

/**
 * Send the mapped request upstream, rotating through the provider's API keys
 * until one succeeds or every key has been tried.
 */
export async function executeCustomRequest(
  options: CustomExecuteOptions,
): Promise<CustomExecuteResult> {
  const { provider, body, modelSpec } = options;
  const keys = await listProviderKeys(provider.id);

  if (keys.length === 0) {
    throw new NoUsableKeyError(provider.id);
  }

  const maxAttempts = Math.min(
    Math.max((() => {
      try {
        return getProxyConfig().retry.maxAttempts;
      } catch {
        return 3;
      }
    })(), 1),
    keys.length,
  );

  const endpoint = chatEndpoint(provider);
  const tried: string[] = [];
  let attempts = 0;
  let lastError = '';

  while (attempts < maxAttempts) {
    attempts += 1;

    const key = selectKey(keys, tried);
    if (!key) {
      // Nothing left to try. If that is because everything is cooling rather
      // than because everything failed, say so with a wait the caller can use.
      const untried = keys.filter((candidate) => !tried.includes(candidate.id));
      if (untried.length > 0) {
        throw new AllKeysCoolingError(provider.id, shortestCooldownMs(untried));
      }
      break;
    }
    tried.push(key.id);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), modelSpec.timeoutMs ?? 60_000);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: buildHeaders(provider, key.apiKey),
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (response.ok) {
        await reward(key);
        return { response, keyId: key.id, attempts };
      }

      lastError = await response.text().catch(() => response.statusText);
      console.warn(
        `[${provider.id}] Key "${key.label}" failed with ${response.status}: ${lastError.slice(0, 300)}`,
      );
      await penalize(key, response.status);
      adminEventBus.emit(
        'log',
        `⚠️ [${provider.id}] key "${key.label}" returned ${response.status}`,
      );

      // Client-side mistakes (bad model, malformed body) fail on every key —
      // returning immediately keeps the real error visible to the caller.
      if (response.status === 400 || response.status === 404 || response.status === 422) {
        return {
          response: new Response(lastError || '{}', {
            status: response.status,
            headers: { 'Content-Type': 'application/json' },
          }),
          keyId: key.id,
          attempts,
        };
      }
    } catch (error: any) {
      clearTimeout(timeout);
      lastError = error?.name === 'AbortError'
        ? `Upstream timed out after ${modelSpec.timeoutMs ?? 60_000}ms`
        : error?.message || String(error);
      console.error(`[${provider.id}] Request failed on key "${key.label}":`, lastError);
      await penalize(key, 500);
    }
  }

  throw new Error(
    `Custom provider "${provider.id}" failed after ${attempts} attempt(s). Last error: ${lastError || 'unknown'}`,
  );
}
