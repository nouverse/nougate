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
function describeProvider(id: string) {
  const record = getCustomProvider(id);
  if (!record) {
    return null;
  }

  return {
    ...record,
    keys: listProviderKeys(id).map(maskKey),
    models: listProviderModels(id),
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
        return json(
          listCustomProviders().map((record) => ({
            ...record,
            keyCount: listProviderKeys(record.id).length,
            modelCount: listProviderModels(record.id).length,
          })),
        );
      }

      if (req.method === 'POST') {
        const body = (await req.json().catch(() => ({}))) as any;
        const record = createCustomProvider(body);

        // Optional one-shot setup: accept the first API key with the provider.
        if (body.apiKey) {
          addProviderKey(record.id, body.apiKey, body.keyLabel);
        }

        syncCustomProvider(record);

        // Only attempt discovery when there is a key to authenticate with.
        let modelSync: unknown = null;
        if (body.autoLoadModels && body.apiKey) {
          try {
            modelSync = await syncProviderModels(record);
            refreshCustomProvider(record.id);
          } catch (error: any) {
            modelSync = { error: error?.message || String(error) };
          }
        }

        adminEventBus.emit('update', {});
        return json({ provider: describeProvider(record.id), modelSync }, 201);
      }
    }

    // Checked before the single-provider routes so "reload" is not mistaken
    // for a provider ID.
    if (providerId === 'reload' && req.method === 'POST') {
      initCustomProviders();
      return json({ ok: true });
    }

    // ── Single provider ──────────────────────────────────────────────────────
    if (providerId && !action) {
      if (req.method === 'GET') {
        const described = describeProvider(providerId);
        return described ? json(described) : json({ error: 'Provider not found' }, 404);
      }

      if (req.method === 'POST') {
        const body = (await req.json().catch(() => ({}))) as any;
        const record = updateCustomProvider(providerId, body);

        if (record.enabled) {
          syncCustomProvider(record);
          refreshCustomProvider(record.id);
        } else {
          removeCustomProviderInstance(record.id);
        }

        adminEventBus.emit('update', {});
        return json(describeProvider(record.id));
      }

      if (req.method === 'DELETE') {
        removeCustomProviderInstance(providerId);
        const removed = deleteCustomProvider(providerId);
        adminEventBus.emit('update', {});
        return removed ? json({ ok: true }) : json({ error: 'Provider not found' }, 404);
      }
    }

    // ── Keys ─────────────────────────────────────────────────────────────────
    if (providerId && action === 'keys') {
      if (req.method === 'GET') {
        return json(listProviderKeys(providerId).map(maskKey));
      }

      if (req.method === 'POST' && !resourceId) {
        const body = (await req.json().catch(() => ({}))) as any;
        const key = addProviderKey(providerId, body.apiKey, body.label);
        refreshCustomProvider(providerId);
        adminEventBus.emit('update', {});
        return json(maskKey(key), 201);
      }

      if (req.method === 'DELETE' && resourceId) {
        const removed = removeProviderKey(providerId, resourceId);
        adminEventBus.emit('update', {});
        return removed ? json({ ok: true }) : json({ error: 'Key not found' }, 404);
      }
    }

    // ── Models ───────────────────────────────────────────────────────────────
    if (providerId && action === 'models') {
      if (req.method === 'GET') {
        return json(listProviderModels(providerId));
      }

      if (req.method === 'POST' && !resourceId) {
        const body = (await req.json().catch(() => ({}))) as any;
        const models = Array.isArray(body) ? body : body.models;
        if (!Array.isArray(models)) {
          return json({ error: 'Expected a "models" array.' }, 400);
        }

        const written = upsertProviderModels(providerId, models);
        refreshCustomProvider(providerId);
        adminEventBus.emit('update', {});
        return json({ written, models: listProviderModels(providerId) });
      }

      if (req.method === 'DELETE' && resourceId) {
        const removed = deleteProviderModel(providerId, resourceId);
        refreshCustomProvider(providerId);
        adminEventBus.emit('update', {});
        return removed ? json({ ok: true }) : json({ error: 'Model not found' }, 404);
      }
    }

    // ── Model auto-discovery ─────────────────────────────────────────────────
    if (providerId && action === 'sync-models' && req.method === 'POST') {
      const record = getCustomProvider(providerId);
      if (!record) {
        return json({ error: 'Provider not found' }, 404);
      }

      const result = await syncProviderModels(record);
      refreshCustomProvider(providerId);
      adminEventBus.emit('update', {});
      return json({ ...result, models: listProviderModels(providerId) });
    }

    return json({ error: 'Unknown custom provider endpoint' }, 404);
  } catch (error) {
    return fail(error);
  }
}
