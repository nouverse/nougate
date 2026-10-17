import {
  type CustomProviderRecord,
  type UpsertModelInput,
  CustomProviderError,
  fillMissingWindows,
  listProviderKeys,
  upsertProviderModels,
} from './store';
import { buildHeaders, modelsEndpoint } from './executor';

export interface ModelSyncResult {
  discovered: string[];
  imported: number;
  skipped: number;
}

/** One model as an upstream lists it: its id, and its context window when the listing states one. */
interface UpstreamModel {
  id: string;
  contextWindow?: number;
}

/**
 * The names upstreams give a model's context window: OpenRouter's `context_length` (and its top provider's), vLLM's
 * `max_model_len`, LM Studio's `max_context_length`, and `context_window` — the first one stated, a whole number of at
 * least 1024. An upstream that states none leaves the window unknown: nothing here guesses one.
 */
export function upstreamWindow(entry: Record<string, unknown>): number | undefined {
  const top = entry.top_provider as Record<string, unknown> | undefined;
  for (const value of [entry.context_window, entry.context_length, top?.context_length, entry.max_model_len, entry.max_context_length]) {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 1024) return value;
  }
  return undefined;
}

/**
 * Pull the model list off an upstream `/models` endpoint.
 *
 * Both API styles expose the same OpenAI-shaped `{ data: [{ id }] }` envelope;
 * a bare array is also accepted since some self-hosted gateways return one.
 */
async function fetchUpstreamModels(provider: CustomProviderRecord): Promise<UpstreamModel[]> {
  const keys = await listProviderKeys(provider.id);
  if (keys.length === 0) {
    throw new CustomProviderError(
      `Add at least one API key to "${provider.id}" before syncing models.`,
    );
  }

  const endpoint = modelsEndpoint(provider);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(endpoint, {
      method: 'GET',
      headers: buildHeaders(provider, keys[0].apiKey),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => response.statusText);
      throw new CustomProviderError(
        `Model discovery failed: ${endpoint} returned ${response.status}. ${detail.slice(0, 200)}`,
        502,
      );
    }

    const payload = await response.json();
    const list = Array.isArray(payload) ? payload : payload?.data;

    if (!Array.isArray(list)) {
      throw new CustomProviderError(
        `Model discovery failed: ${endpoint} did not return a model list.`,
        502,
      );
    }

    return list.flatMap((entry: any): UpstreamModel[] => {
      const id = typeof entry === 'string' ? entry : (entry?.id ?? entry?.name);
      if (typeof id !== 'string' || id.length === 0) return [];
      const window = entry && typeof entry === 'object' ? upstreamWindow(entry) : undefined;
      return [{ id, ...(window ? { contextWindow: window } : {}) }];
    });
  } catch (error: any) {
    if (error instanceof CustomProviderError) {
      throw error;
    }
    if (error?.name === 'AbortError') {
      throw new CustomProviderError(`Model discovery timed out against ${endpoint}.`, 504);
    }
    throw new CustomProviderError(`Model discovery failed: ${error?.message || error}`, 502);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Discover models upstream and import the ones we do not already have.
 *
 * Existing rows are preserved so a re-sync never wipes prices or per-model
 * overrides that were configured by hand.
 */
export async function syncProviderModels(
  provider: CustomProviderRecord,
): Promise<ModelSyncResult> {
  const upstream = await fetchUpstreamModels(provider);
  const discovered = upstream.map((model) => model.id);

  // Discovered models arrive unpriced on purpose. A single blanket price would
  // be stamped onto every model of every vendor an aggregator exposes, and
  // would then shadow the built-in price book, which usually knows better.
  // Set real numbers per model in the Models table when you need them. A
  // context window is different: the upstream stating one is the fact itself.
  const models: UpsertModelInput[] = upstream.map((model) => ({
    modelId: model.id,
    displayName: model.id,
    upstreamModelId: model.id,
    ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
  }));

  const imported = await upsertProviderModels(provider.id, models, true);
  // Models already here keep what was set by hand — but one with no window takes the one its upstream now states.
  await fillMissingWindows(provider.id, new Map(upstream.flatMap((model) => (model.contextWindow ? [[model.id, model.contextWindow] as const] : []))));

  return {
    discovered,
    imported,
    skipped: discovered.length - imported,
  };
}
