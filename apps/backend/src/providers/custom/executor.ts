import type { IModelSpec } from '@/core/interfaces';
import { getProxyConfig } from '@/config/manager';
import { adminEventBus } from '@/core/events';
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
  const candidates = keys.filter(
    (key) => !excludeIds.includes(key.id) && key.cooldownUntil <= now,
  );

  const pool = candidates.length > 0
    // Every key is cooling down — fall back to the least-recently-used one
    // rather than failing the request outright.
    ? candidates
    : keys.filter((key) => !excludeIds.includes(key.id));

  if (pool.length === 0) {
    return null;
  }

  return pool.reduce((best, key) => {
    if (key.healthScore !== best.healthScore) {
      return key.healthScore > best.healthScore ? key : best;
    }
    return key.lastUsed < best.lastUsed ? key : best;
  });
}

function cooldownMs(): number {
  try {
    return getProxyConfig().rotation.cooldown.defaultDurationMs;
  } catch {
    return 60_000;
  }
}

function penalize(key: CustomProviderKeyRecord, statusCode: number): void {
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

  if (statusCode === 429 || statusCode === 503) {
    key.cooldownUntil = Date.now() + cooldownMs();
  }

  persistKeyState(key);
}

function reward(key: CustomProviderKeyRecord): void {
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

  persistKeyState(key);
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
  const keys = listProviderKeys(provider.id);

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
        reward(key);
        return { response, keyId: key.id, attempts };
      }

      lastError = await response.text().catch(() => response.statusText);
      console.warn(
        `[${provider.id}] Key "${key.label}" failed with ${response.status}: ${lastError.slice(0, 300)}`,
      );
      penalize(key, response.status);
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
      penalize(key, 500);
    }
  }

  throw new Error(
    `Custom provider "${provider.id}" failed after ${attempts} attempt(s). Last error: ${lastError || 'unknown'}`,
  );
}
