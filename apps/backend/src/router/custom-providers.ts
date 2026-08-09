import {
  CustomProviderError,
  addProviderKey,
  createCustomProvider,
  deleteCustomProvider,
  deleteProviderModel,
  getCustomProvider,
  listCustomProviders,
  listProviderKeys,
  listProviderModels,
  maskKey,
  removeProviderKey,
  updateCustomProvider,
  upsertProviderModels,
} from '@/providers/custom/store';
import { syncProviderModels } from '@/providers/custom/model-sync';
import {
  initCustomProviders,
  refreshCustomProvider,
  removeCustomProviderInstance,
  syncCustomProvider,
} from '@/providers/custom/manager';
import { adminEventBus } from '@/core/events';
import { resolvePricing } from '@/core/metrics/pricing';

/**
 * Annotate stored model rows with the rate that will actually be billed.
 *
 * The price book lives in the backend, so the dashboard cannot work out on its
 * own whether a row left on "auto" ends up priced or unpriced.
 */
function withPricingStatus(models: Awaited<ReturnType<typeof listProviderModels>>) {
  return models.map((model) => {
    const pricing = resolvePricing({
      modelId: model.modelId,
      pool: model.pool,
      isThinking: model.isThinking,
      maxOutputTokens: model.maxOutputTokens,
      inputPricePer1M: model.inputPricePer1M ?? undefined,
      outputPricePer1M: model.outputPricePer1M ?? undefined,
    });

    return {
      ...model,
      isPriced: pricing.isPriced,
      effectiveInputPricePer1M: pricing.inputPricePer1M,
      effectiveOutputPricePer1M: pricing.outputPricePer1M,
    };
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function fail(error: unknown): Response {
  if (error instanceof CustomProviderError) {
    return json({ error: error.message }, error.status);
  }
  console.error('[CustomProviders API] Request failed:', error);
  return json({ error: (error as any)?.message || String(error) }, 500);
}

/**
 * Build the dashboard payload for a provider, with API keys masked.
 */
async function describeProvider(id: string) {
  const record = await getCustomProvider(id);
  if (!record) {
    return null;
  }

  // Models are deliberately omitted: an aggregator like OpenRouter has ~400 of
  // them, and shipping the whole list on every provider view — then rendering a
  // form row for each — is the single heaviest thing this page can do. The
  // Models panel fetches them from /models when it is opened.
  return {
    ...record,
    keys: (await listProviderKeys(id)).map(maskKey),
    modelCount: (await listProviderModels(id)).length,
  };
}

/**
 * Serve custom provider CRUD, key management, and model sync.
 * Returns null when the path is not a custom provider route.
 */
export async function handleCustomProvidersRoute(
  req: Request,
  url: URL,
): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/custom-providers')) {
    return null;
  }

  const segments = url.pathname.split('/').filter(Boolean); // ['api','custom-providers',...]
  const providerId = segments[2] ? decodeURIComponent(segments[2]) : null;
  const action = segments[3] ?? null;
  const resourceId = segments[4] ? decodeURIComponent(segments[4]) : null;

  try {
    // ── Collection ───────────────────────────────────────────────────────────
    if (!providerId) {
      if (req.method === 'GET') {
        const providers = await listCustomProviders();
        return json(
          await Promise.all(
            providers.map(async (record) => ({
              ...record,
              keyCount: (await listProviderKeys(record.id)).length,
              modelCount: (await listProviderModels(record.id)).length,
            })),
          ),
        );
      }

      if (req.method === 'POST') {
        const body = (await req.json().catch(() => ({}))) as any;
        const record = await createCustomProvider(body);

        // Optional one-shot setup: accept the first API key with the provider.
        if (body.apiKey) {
          await addProviderKey(record.id, body.apiKey, body.keyLabel);
        }

        await syncCustomProvider(record);

        // Only attempt discovery when there is a key to authenticate with.
        let modelSync: unknown = null;
        if (body.autoLoadModels && body.apiKey) {
          try {
            modelSync = await syncProviderModels(record);
            await refreshCustomProvider(record.id);
          } catch (error: any) {
            modelSync = { error: error?.message || String(error) };
          }
        }

        adminEventBus.emit('update', {});
        return json({ provider: await describeProvider(record.id), modelSync }, 201);
      }
    }

    // Checked before the single-provider routes so "reload" is not mistaken
    // for a provider ID.
    if (providerId === 'reload' && req.method === 'POST') {
      await initCustomProviders();
      return json({ ok: true });
    }

    // ── Single provider ──────────────────────────────────────────────────────
    if (providerId && !action) {
      if (req.method === 'GET') {
        const described = await describeProvider(providerId);
        return described ? json(described) : json({ error: 'Provider not found' }, 404);
      }

      if (req.method === 'POST') {
        const body = (await req.json().catch(() => ({}))) as any;
        const record = await updateCustomProvider(providerId, body);

        if (record.enabled) {
          await syncCustomProvider(record);
          await refreshCustomProvider(record.id);
        } else {
          removeCustomProviderInstance(record.id);
        }

        adminEventBus.emit('update', {});
        return json(await describeProvider(record.id));
      }

      if (req.method === 'DELETE') {
        removeCustomProviderInstance(providerId);
        const removed = await deleteCustomProvider(providerId);
        adminEventBus.emit('update', {});
        return removed ? json({ ok: true }) : json({ error: 'Provider not found' }, 404);
      }
    }

    // ── Keys ─────────────────────────────────────────────────────────────────
    if (providerId && action === 'keys') {
      if (req.method === 'GET') {
        return json((await listProviderKeys(providerId)).map(maskKey));
      }

      if (req.method === 'POST' && !resourceId) {
        const body = (await req.json().catch(() => ({}))) as any;
        const key = await addProviderKey(providerId, body.apiKey, body.label);
        await refreshCustomProvider(providerId);
        adminEventBus.emit('update', {});
        return json(maskKey(key), 201);
      }

      if (req.method === 'DELETE' && resourceId) {
        const removed = await removeProviderKey(providerId, resourceId);
        adminEventBus.emit('update', {});
        return removed ? json({ ok: true }) : json({ error: 'Key not found' }, 404);
      }
    }

    // ── Models ───────────────────────────────────────────────────────────────
    if (providerId && action === 'models') {
      if (req.method === 'GET') {
        return json(await withPricingStatus(await listProviderModels(providerId)));
      }

      if (req.method === 'POST' && !resourceId) {
        const body = (await req.json().catch(() => ({}))) as any;
        const models = Array.isArray(body) ? body : body.models;
        if (!Array.isArray(models)) {
          return json({ error: 'Expected a "models" array.' }, 400);
        }

        const written = await upsertProviderModels(providerId, models);
        await refreshCustomProvider(providerId);
        adminEventBus.emit('update', {});
        return json({ written, models: await withPricingStatus(await listProviderModels(providerId)) });
      }

      if (req.method === 'DELETE' && resourceId) {
        const removed = await deleteProviderModel(providerId, resourceId);
        await refreshCustomProvider(providerId);
        adminEventBus.emit('update', {});
        return removed ? json({ ok: true }) : json({ error: 'Model not found' }, 404);
      }
    }

    // ── Model auto-discovery ─────────────────────────────────────────────────
    if (providerId && action === 'sync-models' && req.method === 'POST') {
      const record = await getCustomProvider(providerId);
      if (!record) {
        return json({ error: 'Provider not found' }, 404);
      }

      const result = await syncProviderModels(record);
      await refreshCustomProvider(providerId);
      adminEventBus.emit('update', {});
      return json({ ...result, models: await withPricingStatus(await listProviderModels(providerId)) });
    }

    return json({ error: 'Unknown custom provider endpoint' }, 404);
  } catch (error) {
    return fail(error);
  }
}
