import { dbAll, dbGet, dbPrepare, dbRun, dbTransaction } from '@/core/db';
import { getProvider } from '@/core/registry';

export type CustomApiStyle = 'openai' | 'anthropic';

export interface CustomProviderRecord {
  id: string;
  displayName: string;
  baseUrl: string;
  apiStyle: CustomApiStyle;
  enabled: boolean;
  extraHeaders: Record<string, string>;
  defaultInputPrice: number | null;
  defaultOutputPrice: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface CustomProviderKeyRecord {
  id: string;
  providerId: string;
  label: string;
  apiKey: string;
  healthScore: number;
  lastUsed: number;
  cooldownUntil: number;
  consecutiveFailures: number;
  tokenUsage: number;
  createdAt: number;
}

export interface CustomProviderModelRecord {
  providerId: string;
  modelId: string;
  displayName: string | null;
  upstreamModelId: string | null;
  pool: 'cli' | 'sandbox';
  isThinking: boolean;
  thinkingMode: 'budget' | 'level' | null;
  thinkingBudget: number | null;
  maxOutputTokens: number;
  timeoutMs: number;
  inputPricePer1M: number | null;
  outputPricePer1M: number | null;
  enabled: boolean;
}

/**
 * Provider IDs become the `{provider_id}:{model}` prefix, so they must match
 * what the model resolver is willing to parse.
 */
const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9_-]*$/;

export class CustomProviderError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'CustomProviderError';
    this.status = status;
  }
}

function rowToProvider(row: any): CustomProviderRecord {
  return {
    id: row.id,
    displayName: row.display_name,
    baseUrl: row.base_url,
    apiStyle: row.api_style === 'anthropic' ? 'anthropic' : 'openai',
    enabled: row.enabled === 1,
    extraHeaders: row.extra_headers ? safeParseHeaders(row.extra_headers) : {},
    defaultInputPrice: row.default_input_price ?? null,
    defaultOutputPrice: row.default_output_price ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function safeParseHeaders(value: string): Record<string, string> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function rowToKey(row: any): CustomProviderKeyRecord {
  return {
    id: row.id,
    providerId: row.provider_id,
    label: row.label,
    apiKey: row.api_key,
    healthScore: row.health_score,
    lastUsed: row.last_used,
    cooldownUntil: row.cooldown_until,
    consecutiveFailures: row.consecutive_failures,
    tokenUsage: row.token_usage,
    createdAt: row.created_at,
  };
}

function rowToModel(row: any): CustomProviderModelRecord {
  return {
    providerId: row.provider_id,
    modelId: row.model_id,
    displayName: row.display_name ?? null,
    upstreamModelId: row.upstream_model_id ?? null,
    pool: row.pool === 'sandbox' ? 'sandbox' : 'cli',
    isThinking: row.is_thinking === 1,
    thinkingMode: row.thinking_mode ?? null,
    thinkingBudget: row.thinking_budget ?? null,
    maxOutputTokens: row.max_output_tokens,
    timeoutMs: row.timeout_ms,
    inputPricePer1M: row.input_price_per_1m ?? null,
    outputPricePer1M: row.output_price_per_1m ?? null,
    enabled: row.enabled === 1,
  };
}

/**
 * Normalize a base URL so endpoint building can assume no trailing slash.
 */
function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new CustomProviderError('Base URL must start with http:// or https://');
  }
  return trimmed;
}

// ─── Providers ────────────────────────────────────────────────────────────────

export function listCustomProviders(): CustomProviderRecord[] {
  const rows = dbAll('SELECT * FROM custom_providers ORDER BY created_at ASC');
  return rows.map(rowToProvider);
}

export function getCustomProvider(id: string): CustomProviderRecord | null {
  const row = dbGet('SELECT * FROM custom_providers WHERE id = $id', { $id: id });
  return row ? rowToProvider(row) : null;
}

export interface CreateCustomProviderInput {
  id: string;
  displayName?: string;
  baseUrl: string;
  apiStyle?: CustomApiStyle;
  extraHeaders?: Record<string, string>;
  defaultInputPrice?: number | null;
  defaultOutputPrice?: number | null;
  enabled?: boolean;
}

export function createCustomProvider(input: CreateCustomProviderInput): CustomProviderRecord {
  const id = (input.id ?? '').trim().toLowerCase();

  if (!PROVIDER_ID_PATTERN.test(id)) {
    throw new CustomProviderError(
      `Invalid provider id "${input.id}". Use lowercase letters, digits, "-" or "_", starting with a letter (e.g. "deepseek").`,
    );
  }

  // Built-in providers are registered before custom ones, so a collision would
  // silently shadow one of them at model-resolution time.
  if (getProvider(id) || getCustomProvider(id)) {
    throw new CustomProviderError(`Provider id "${id}" is already in use.`, 409);
  }

  const now = Date.now();
  const record: CustomProviderRecord = {
    id,
    displayName: input.displayName?.trim() || id,
    baseUrl: normalizeBaseUrl(input.baseUrl ?? ''),
    apiStyle: input.apiStyle === 'anthropic' ? 'anthropic' : 'openai',
    enabled: input.enabled !== false,
    extraHeaders: input.extraHeaders ?? {},
    defaultInputPrice: input.defaultInputPrice ?? null,
    defaultOutputPrice: input.defaultOutputPrice ?? null,
    createdAt: now,
    updatedAt: now,
  };

  dbRun(
    `INSERT INTO custom_providers (
       id, display_name, base_url, api_style, enabled, extra_headers,
       default_input_price, default_output_price, created_at, updated_at
     ) VALUES ($id, $displayName, $baseUrl, $apiStyle, $enabled, $extraHeaders,
       $defaultInputPrice, $defaultOutputPrice, $createdAt, $updatedAt)`,
    {
      $id: record.id,
      $displayName: record.displayName,
      $baseUrl: record.baseUrl,
      $apiStyle: record.apiStyle,
      $enabled: record.enabled ? 1 : 0,
      $extraHeaders: JSON.stringify(record.extraHeaders),
      $defaultInputPrice: record.defaultInputPrice,
      $defaultOutputPrice: record.defaultOutputPrice,
      $createdAt: record.createdAt,
      $updatedAt: record.updatedAt,
    },
  );

  return record;
}

export type UpdateCustomProviderInput = Partial<Omit<CreateCustomProviderInput, 'id'>>;

export function updateCustomProvider(
  id: string,
  updates: UpdateCustomProviderInput,
): CustomProviderRecord {
  const existing = getCustomProvider(id);
  if (!existing) {
    throw new CustomProviderError(`Custom provider "${id}" not found.`, 404);
  }

  const merged: CustomProviderRecord = {
    ...existing,
    displayName: updates.displayName?.trim() || existing.displayName,
    baseUrl: updates.baseUrl ? normalizeBaseUrl(updates.baseUrl) : existing.baseUrl,
    apiStyle: updates.apiStyle ?? existing.apiStyle,
    enabled: updates.enabled ?? existing.enabled,
    extraHeaders: updates.extraHeaders ?? existing.extraHeaders,
    defaultInputPrice:
      updates.defaultInputPrice === undefined ? existing.defaultInputPrice : updates.defaultInputPrice,
    defaultOutputPrice:
      updates.defaultOutputPrice === undefined ? existing.defaultOutputPrice : updates.defaultOutputPrice,
    updatedAt: Date.now(),
  };

  dbRun(
    `UPDATE custom_providers SET
       display_name = $displayName, base_url = $baseUrl, api_style = $apiStyle,
       enabled = $enabled, extra_headers = $extraHeaders,
       default_input_price = $defaultInputPrice, default_output_price = $defaultOutputPrice,
       updated_at = $updatedAt
     WHERE id = $id`,
    {
      $id: merged.id,
      $displayName: merged.displayName,
      $baseUrl: merged.baseUrl,
      $apiStyle: merged.apiStyle,
      $enabled: merged.enabled ? 1 : 0,
      $extraHeaders: JSON.stringify(merged.extraHeaders),
      $defaultInputPrice: merged.defaultInputPrice,
      $defaultOutputPrice: merged.defaultOutputPrice,
      $updatedAt: merged.updatedAt,
    },
  );

  return merged;
}

export function deleteCustomProvider(id: string): boolean {
  const result = dbRun('DELETE FROM custom_providers WHERE id = $id', { $id: id });
  return result.changes > 0;
}

// ─── Keys (rotated like accounts) ─────────────────────────────────────────────

export function listProviderKeys(providerId: string): CustomProviderKeyRecord[] {
  const rows = dbAll(
    'SELECT * FROM custom_provider_keys WHERE provider_id = $providerId ORDER BY created_at ASC',
    { $providerId: providerId },
  );
  return rows.map(rowToKey);
}

export function addProviderKey(
  providerId: string,
  apiKey: string,
  label?: string,
): CustomProviderKeyRecord {
  if (!getCustomProvider(providerId)) {
    throw new CustomProviderError(`Custom provider "${providerId}" not found.`, 404);
  }

  const trimmed = (apiKey ?? '').trim();
  if (!trimmed) {
    throw new CustomProviderError('API key is required.');
  }

  const record: CustomProviderKeyRecord = {
    id: crypto.randomUUID(),
    providerId,
    label: label?.trim() || `key-${trimmed.slice(-4)}`,
    apiKey: trimmed,
    healthScore: 100,
    lastUsed: 0,
    cooldownUntil: 0,
    consecutiveFailures: 0,
    tokenUsage: 0,
    createdAt: Date.now(),
  };

  dbRun(
    `INSERT INTO custom_provider_keys (
       id, provider_id, label, api_key, health_score, last_used,
       cooldown_until, consecutive_failures, token_usage, created_at
     ) VALUES ($id, $providerId, $label, $apiKey, 100, 0, 0, 0, 0, $createdAt)`,
    {
      $id: record.id,
      $providerId: record.providerId,
      $label: record.label,
      $apiKey: record.apiKey,
      $createdAt: record.createdAt,
    },
  );

  return record;
}

export function removeProviderKey(providerId: string, keyId: string): boolean {
  const result = dbRun(
    'DELETE FROM custom_provider_keys WHERE provider_id = $providerId AND id = $id',
    { $providerId: providerId, $id: keyId },
  );
  return result.changes > 0;
}

export function persistKeyState(key: CustomProviderKeyRecord): void {
  dbRun(
    `UPDATE custom_provider_keys SET
       health_score = $healthScore, last_used = $lastUsed, cooldown_until = $cooldownUntil,
       consecutive_failures = $consecutiveFailures, token_usage = $tokenUsage
     WHERE id = $id`,
    {
      $id: key.id,
      $healthScore: key.healthScore,
      $lastUsed: key.lastUsed,
      $cooldownUntil: key.cooldownUntil,
      $consecutiveFailures: key.consecutiveFailures,
      $tokenUsage: key.tokenUsage,
    },
  );
}

export function resetProviderKeys(providerId: string): void {
  dbRun(
    `UPDATE custom_provider_keys
     SET health_score = 100, cooldown_until = 0, consecutive_failures = 0
     WHERE provider_id = $providerId`,
    { $providerId: providerId },
  );
}

// ─── Models ───────────────────────────────────────────────────────────────────

export function listProviderModels(providerId: string): CustomProviderModelRecord[] {
  const rows = dbAll(
    'SELECT * FROM custom_provider_models WHERE provider_id = $providerId ORDER BY model_id ASC',
    { $providerId: providerId },
  );
  return rows.map(rowToModel);
}

export interface UpsertModelInput {
  modelId: string;
  displayName?: string | null;
  upstreamModelId?: string | null;
  pool?: 'cli' | 'sandbox';
  isThinking?: boolean;
  thinkingMode?: 'budget' | 'level' | null;
  thinkingBudget?: number | null;
  maxOutputTokens?: number;
  timeoutMs?: number;
  inputPricePer1M?: number | null;
  outputPricePer1M?: number | null;
  enabled?: boolean;
}

/**
 * Insert or update models for a provider.
 *
 * `preserveExisting` is what makes auto-sync safe to re-run: discovered models
 * are added, but prices and overrides a user already set are left untouched.
 */
export function upsertProviderModels(
  providerId: string,
  models: UpsertModelInput[],
  preserveExisting = false,
): number {
  if (!getCustomProvider(providerId)) {
    throw new CustomProviderError(`Custom provider "${providerId}" not found.`, 404);
  }

  const existing = new Set(listProviderModels(providerId).map((model) => model.modelId));

  const statement = dbPrepare(
    `INSERT INTO custom_provider_models (
       provider_id, model_id, display_name, upstream_model_id, pool, is_thinking,
       thinking_mode, thinking_budget, max_output_tokens, timeout_ms,
       input_price_per_1m, output_price_per_1m, enabled
     ) VALUES (
       $providerId, $modelId, $displayName, $upstreamModelId, $pool, $isThinking,
       $thinkingMode, $thinkingBudget, $maxOutputTokens, $timeoutMs,
       $inputPrice, $outputPrice, $enabled
     )
     ON CONFLICT (provider_id, model_id) DO UPDATE SET
       display_name = excluded.display_name,
       upstream_model_id = excluded.upstream_model_id,
       pool = excluded.pool,
       is_thinking = excluded.is_thinking,
       thinking_mode = excluded.thinking_mode,
       thinking_budget = excluded.thinking_budget,
       max_output_tokens = excluded.max_output_tokens,
       timeout_ms = excluded.timeout_ms,
       input_price_per_1m = excluded.input_price_per_1m,
       output_price_per_1m = excluded.output_price_per_1m,
       enabled = excluded.enabled`,
  );

  let written = 0;
  const write = dbTransaction((entries: UpsertModelInput[]) => {
    for (const entry of entries) {
      const modelId = (entry.modelId ?? '').trim();
      if (!modelId) {
        continue;
      }
      if (preserveExisting && existing.has(modelId)) {
        continue;
      }

      statement.run({
        $providerId: providerId,
        $modelId: modelId,
        $displayName: entry.displayName ?? modelId,
        $upstreamModelId: entry.upstreamModelId ?? modelId,
        $pool: entry.pool ?? 'cli',
        $isThinking: entry.isThinking ? 1 : 0,
        $thinkingMode: entry.thinkingMode ?? null,
        $thinkingBudget: entry.thinkingBudget ?? null,
        $maxOutputTokens: entry.maxOutputTokens ?? 8192,
        $timeoutMs: entry.timeoutMs ?? 60000,
        $inputPrice: entry.inputPricePer1M ?? null,
        $outputPrice: entry.outputPricePer1M ?? null,
        $enabled: entry.enabled === false ? 0 : 1,
      });
      written += 1;
    }
  });

  write(models);
  return written;
}

export function deleteProviderModel(providerId: string, modelId: string): boolean {
  const result = dbRun(
    'DELETE FROM custom_provider_models WHERE provider_id = $providerId AND model_id = $modelId',
    { $providerId: providerId, $modelId: modelId },
  );
  return result.changes > 0;
}

/**
 * Hide the secret when a key is sent to the dashboard.
 */
export function maskKey(key: CustomProviderKeyRecord) {
  return {
    ...key,
    apiKey: `••••${key.apiKey.slice(-4)}`,
  };
}
