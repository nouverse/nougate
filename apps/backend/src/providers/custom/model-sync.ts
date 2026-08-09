import {
  type CustomProviderRecord,
  type UpsertModelInput,
  CustomProviderError,
  listProviderKeys,
  upsertProviderModels,
} from './store';
import { buildHeaders, modelsEndpoint } from './executor';

export interface ModelSyncResult {
  discovered: string[];
  imported: number;
  skipped: number;
}

/**
 * Pull the model list off an upstream `/models` endpoint.
 *
 * Both API styles expose the same OpenAI-shaped `{ data: [{ id }] }` envelope;
 * a bare array is also accepted since some self-hosted gateways return one.
 */
async function fetchUpstreamModels(provider: CustomProviderRecord): Promise<string[]> {
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

    return list
      .map((entry: any) => (typeof entry === 'string' ? entry : entry?.id ?? entry?.name))
      .filter((id: unknown): id is string => typeof id === 'string' && id.length > 0);
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
  const discovered = await fetchUpstreamModels(provider);

  // Discovered models arrive unpriced on purpose. A single blanket price would
  // be stamped onto every model of every vendor an aggregator exposes, and
  // would then shadow the built-in price book, which usually knows better.
  // Set real numbers per model in the Models table when you need them.
  const models: UpsertModelInput[] = discovered.map((modelId) => ({
    modelId,
    displayName: modelId,
    upstreamModelId: modelId,
  }));

  const imported = await upsertProviderModels(provider.id, models, true);

  return {
    discovered,
    imported,
    skipped: discovered.length - imported,
  };
}
