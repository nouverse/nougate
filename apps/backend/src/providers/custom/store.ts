import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { getDb, t } from '@/core/db';
import { type JitterConfig, normalizeJitterConfig } from '@/core/jitter';
import { getProvider } from '@/core/registry';
import { assertAccountSlotAvailable } from '@/core/rotation-pool';

export type CustomApiStyle = 'openai' | 'anthropic';

export interface CustomProviderRecord {
  id: string;
  displayName: string;
  baseUrl: string;
  apiStyle: CustomApiStyle;
  enabled: boolean;
  extraHeaders: Record<string, string>;
  /**
   * How long to wait before this provider's requests go upstream. Per provider
   * rather than shared: a self-hosted endpoint has no reason to be spaced out
   * the way a rate-limited commercial one does.
   */
  jitter: JitterConfig;
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
  /** Null: unknown — nothing stated it. Never a default (`IModelSpec.contextWindow`). */
  contextWindow: number | null;
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
    displayName: row.displayName,
    baseUrl: row.baseUrl,
    apiStyle: row.apiStyle === 'anthropic' ? 'anthropic' : 'openai',
    enabled: row.enabled === 1,
    extraHeaders: row.extraHeaders ? safeParseHeaders(row.extraHeaders) : {},
    // A null column is a provider created before jitter was configurable, so it
    // takes the shared default rather than being read as "no delay".
    jitter: normalizeJitterConfig({
      jitterEnabled: row.jitterEnabled === null || row.jitterEnabled === undefined
        ? undefined
        : row.jitterEnabled === 1,
      jitterMinMs: row.jitterMinMs ?? undefined,
      jitterMaxMs: row.jitterMaxMs ?? undefined,
    }),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
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
    providerId: row.providerId,
    label: row.label,
    apiKey: row.apiKey,
    healthScore: row.healthScore,
    lastUsed: Number(row.lastUsed),
    cooldownUntil: Number(row.cooldownUntil),
    consecutiveFailures: row.consecutiveFailures,
    tokenUsage: Number(row.tokenUsage),
    createdAt: Number(row.createdAt),
  };
}

function rowToModel(row: any): CustomProviderModelRecord {
  return {
    providerId: row.providerId,
    modelId: row.modelId,
    displayName: row.displayName ?? null,
    upstreamModelId: row.upstreamModelId ?? null,
    pool: row.pool === 'sandbox' ? 'sandbox' : 'cli',
    isThinking: row.isThinking === 1,
    thinkingMode: row.thinkingMode ?? null,
    thinkingBudget: row.thinkingBudget ?? null,
    maxOutputTokens: row.maxOutputTokens,
    contextWindow: row.contextWindow ?? null,
    timeoutMs: row.timeoutMs,
    inputPricePer1M: row.inputPricePer1M ?? null,
    outputPricePer1M: row.outputPricePer1M ?? null,
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

export async function listCustomProviders(): Promise<CustomProviderRecord[]> {
  const rows = await getDb().select().from(t.customProviders).orderBy(asc(t.customProviders.createdAt));
  return rows.map(rowToProvider);
}

export async function getCustomProvider(id: string): Promise<CustomProviderRecord | null> {
  const [row] = await getDb()
    .select()
    .from(t.customProviders)
    .where(eq(t.customProviders.id, id))
    .limit(1);
  return row ? rowToProvider(row) : null;
}

export interface CreateCustomProviderInput {
  id: string;
  displayName?: string;
  baseUrl: string;
  apiStyle?: CustomApiStyle;
  extraHeaders?: Record<string, string>;
  enabled?: boolean;
  jitter?: Partial<JitterConfig>;
}

export async function createCustomProvider(input: CreateCustomProviderInput): Promise<CustomProviderRecord> {
  const id = (input.id ?? '').trim().toLowerCase();

  if (!PROVIDER_ID_PATTERN.test(id)) {
    throw new CustomProviderError(
      `Invalid provider id "${input.id}". Use lowercase letters, digits, "-" or "_", starting with a letter (e.g. "deepseek").`,
    );
  }

  // Built-in providers are registered before custom ones, so a collision would
  // silently shadow one of them at model-resolution time.
  if (getProvider(id) || (await getCustomProvider(id))) {
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
    jitter: normalizeJitterConfig(input.jitter),
    createdAt: now,
    updatedAt: now,
  };

  await getDb().insert(t.customProviders).values({
    id: record.id,
    displayName: record.displayName,
    baseUrl: record.baseUrl,
    apiStyle: record.apiStyle,
    enabled: record.enabled ? 1 : 0,
    extraHeaders: JSON.stringify(record.extraHeaders),
    jitterEnabled: record.jitter.jitterEnabled ? 1 : 0,
    jitterMinMs: record.jitter.jitterMinMs,
    jitterMaxMs: record.jitter.jitterMaxMs,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });

  return record;
}

export type UpdateCustomProviderInput = Partial<Omit<CreateCustomProviderInput, 'id'>>;

export async function updateCustomProvider(
  id: string,
  updates: UpdateCustomProviderInput,
): Promise<CustomProviderRecord> {
  const existing = await getCustomProvider(id);
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
    // Merged field by field, so the dashboard can send just the one control the
    // user touched without resetting the other two to defaults.
    jitter: normalizeJitterConfig({ ...existing.jitter, ...updates.jitter }),
    updatedAt: Date.now(),
  };

  await getDb()
    .update(t.customProviders)
    .set({
      displayName: merged.displayName,
      baseUrl: merged.baseUrl,
      apiStyle: merged.apiStyle,
      enabled: merged.enabled ? 1 : 0,
      extraHeaders: JSON.stringify(merged.extraHeaders),
      jitterEnabled: merged.jitter.jitterEnabled ? 1 : 0,
      jitterMinMs: merged.jitter.jitterMinMs,
      jitterMaxMs: merged.jitter.jitterMaxMs,
      updatedAt: merged.updatedAt,
    })
    .where(eq(t.customProviders.id, merged.id));

  return merged;
}

export async function deleteCustomProvider(id: string): Promise<boolean> {
  if (!(await getCustomProvider(id))) {
    return false;
  }

  // Models and keys are removed explicitly rather than relying on cascade,
  // which SQLite only honours when foreign keys are switched on.
  await getDb().delete(t.customProviderModels).where(eq(t.customProviderModels.providerId, id));
  await getDb().delete(t.customProviderKeys).where(eq(t.customProviderKeys.providerId, id));
  await getDb().delete(t.customProviders).where(eq(t.customProviders.id, id));
  return true;
}

// ─── Keys (rotated like accounts) ─────────────────────────────────────────────

export async function listProviderKeys(providerId: string): Promise<CustomProviderKeyRecord[]> {
  const rows = await getDb()
    .select()
    .from(t.customProviderKeys)
    .where(eq(t.customProviderKeys.providerId, providerId))
    .orderBy(asc(t.customProviderKeys.createdAt));
  return rows.map(rowToKey);
}

export async function addProviderKey(
  providerId: string,
  apiKey: string,
  label?: string,
): Promise<CustomProviderKeyRecord> {
  if (!(await getCustomProvider(providerId))) {
    throw new CustomProviderError(`Custom provider "${providerId}" not found.`, 404);
  }

  const trimmed = (apiKey ?? '').trim();
  if (!trimmed) {
    throw new CustomProviderError('API key is required.');
  }

  // The first key is "primary" — which is what the form's placeholder promises.
  // Later ones fall back to the key's last four characters, so an unlabelled
  // second key cannot collide with the first.
  const existingCount = (await listProviderKeys(providerId)).length;

  // A custom provider's API keys are its accounts, so they are capped the same
  // way Antigravity's and Copilot's are.
  assertAccountSlotAvailable(`API key for "${providerId}"`, existingCount);

  const fallbackLabel = existingCount === 0 ? 'primary' : `key-${trimmed.slice(-4)}`;

  const record: CustomProviderKeyRecord = {
    id: crypto.randomUUID(),
    providerId,
    label: label?.trim() || fallbackLabel,
    apiKey: trimmed,
    healthScore: 100,
    lastUsed: 0,
    cooldownUntil: 0,
    consecutiveFailures: 0,
    tokenUsage: 0,
    createdAt: Date.now(),
  };

  await getDb().insert(t.customProviderKeys).values({
    id: record.id,
    providerId: record.providerId,
    label: record.label,
    apiKey: record.apiKey,
    healthScore: 100,
    lastUsed: 0,
    cooldownUntil: 0,
    consecutiveFailures: 0,
    tokenUsage: 0,
    createdAt: record.createdAt,
  });

  return record;
}

export async function removeProviderKey(providerId: string, keyId: string): Promise<boolean> {
  const [existing] = await getDb()
    .select({ id: t.customProviderKeys.id })
    .from(t.customProviderKeys)
    .where(and(eq(t.customProviderKeys.providerId, providerId), eq(t.customProviderKeys.id, keyId)));
  if (!existing) {
    return false;
  }

  await getDb()
    .delete(t.customProviderKeys)
    .where(and(eq(t.customProviderKeys.providerId, providerId), eq(t.customProviderKeys.id, keyId)));
  return true;
}

export async function persistKeyState(key: CustomProviderKeyRecord): Promise<void> {
  await getDb()
    .update(t.customProviderKeys)
    .set({
      healthScore: key.healthScore,
      lastUsed: key.lastUsed,
      cooldownUntil: key.cooldownUntil,
      consecutiveFailures: key.consecutiveFailures,
      tokenUsage: key.tokenUsage,
    })
    .where(eq(t.customProviderKeys.id, key.id));
}

export async function resetProviderKeys(providerId: string): Promise<void> {
  await getDb()
    .update(t.customProviderKeys)
    .set({ healthScore: 100, cooldownUntil: 0, consecutiveFailures: 0 })
    .where(eq(t.customProviderKeys.providerId, providerId));
}

// ─── Models ───────────────────────────────────────────────────────────────────

export async function listProviderModels(providerId: string): Promise<CustomProviderModelRecord[]> {
  const rows = await getDb()
    .select()
    .from(t.customProviderModels)
    .where(eq(t.customProviderModels.providerId, providerId))
    .orderBy(asc(t.customProviderModels.modelId));
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
  contextWindow?: number | null;
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
export async function upsertProviderModels(
  providerId: string,
  models: UpsertModelInput[],
  preserveExisting = false,
): Promise<number> {
  if (!(await getCustomProvider(providerId))) {
    throw new CustomProviderError(`Custom provider "${providerId}" not found.`, 404);
  }

  const existing = new Set((await listProviderModels(providerId)).map((model) => model.modelId));

  const rows = models
    .map((entry) => ({ entry, modelId: (entry.modelId ?? '').trim() }))
    .filter(({ modelId }) => modelId)
    .filter(({ modelId }) => !(preserveExisting && existing.has(modelId)))
    .map(({ entry, modelId }) => ({
      providerId,
      modelId,
      displayName: entry.displayName ?? modelId,
      upstreamModelId: entry.upstreamModelId ?? modelId,
      pool: entry.pool ?? 'cli',
      isThinking: entry.isThinking ? 1 : 0,
      thinkingMode: entry.thinkingMode ?? null,
      thinkingBudget: entry.thinkingBudget ?? null,
      maxOutputTokens: entry.maxOutputTokens ?? 8192,
      contextWindow: windowOrNull(entry.contextWindow),
      timeoutMs: entry.timeoutMs ?? 60000,
      inputPricePer1M: entry.inputPricePer1M ?? null,
      outputPricePer1M: entry.outputPricePer1M ?? null,
      enabled: entry.enabled === false ? 0 : 1,
    }));

  if (rows.length === 0) {
    return 0;
  }

  // Upsert keyed on (provider, model): both dialects speak this ON CONFLICT form.
  await getDb()
    .insert(t.customProviderModels)
    .values(rows)
    .onConflictDoUpdate({
      target: [t.customProviderModels.providerId, t.customProviderModels.modelId],
      set: {
        displayName: sql`excluded.display_name`,
        upstreamModelId: sql`excluded.upstream_model_id`,
        pool: sql`excluded.pool`,
        isThinking: sql`excluded.is_thinking`,
        thinkingMode: sql`excluded.thinking_mode`,
        thinkingBudget: sql`excluded.thinking_budget`,
        maxOutputTokens: sql`excluded.max_output_tokens`,
        contextWindow: sql`excluded.context_window`,
        timeoutMs: sql`excluded.timeout_ms`,
        inputPricePer1M: sql`excluded.input_price_per_1m`,
        outputPricePer1M: sql`excluded.output_price_per_1m`,
        enabled: sql`excluded.enabled`,
      },
    });

  return rows.length;
}

/** A context window as stored: a whole number of at least 1024, else unknown. Never a default. */
function windowOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1024 ? value : null;
}

/**
 * Give models a sync found again the context window their upstream states — only where none is stored, so a window
 * the operator corrected by hand stays. Returns how many rows took one.
 */
export async function fillMissingWindows(providerId: string, windows: ReadonlyMap<string, number>): Promise<number> {
  const missing = new Set(
    (
      await getDb()
        .select({ modelId: t.customProviderModels.modelId })
        .from(t.customProviderModels)
        .where(and(eq(t.customProviderModels.providerId, providerId), isNull(t.customProviderModels.contextWindow)))
    ).map((row) => row.modelId),
  );
  let filled = 0;
  for (const [modelId, window] of windows) {
    const stored = windowOrNull(window);
    if (stored === null || !missing.has(modelId)) continue;
    await getDb()
      .update(t.customProviderModels)
      .set({ contextWindow: stored })
      .where(and(eq(t.customProviderModels.providerId, providerId), eq(t.customProviderModels.modelId, modelId)));
    filled += 1;
  }
  return filled;
}

export async function deleteProviderModel(providerId: string, modelId: string): Promise<boolean> {
  const where = and(
    eq(t.customProviderModels.providerId, providerId),
    eq(t.customProviderModels.modelId, modelId),
  );

  const [existing] = await getDb()
    .select({ modelId: t.customProviderModels.modelId })
    .from(t.customProviderModels)
    .where(where);
  if (!existing) {
    return false;
  }

  await getDb().delete(t.customProviderModels).where(where);
  return true;
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
