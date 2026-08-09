import {
  createApiKey,
  deleteApiKey,
  flushApiKeyUsage,
  isApiKeyAuthEnabled,
  listApiKeys,
  revokeApiKey,
} from '@/auth/api-keys';
import { getProxyConfig, updateProxyConfig } from '@/config/manager';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Serve gateway API key management.
 * Returns null when the path is not an API key route.
 */
export async function handleApiKeysRoute(req: Request, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/api-keys')) {
    return null;
  }

  try {
    if (url.pathname === '/api/api-keys' && req.method === 'GET') {
      // Usage counters buffer in memory between timer flushes; write them out
      // first so the dashboard never shows a stale request count.
      await flushApiKeyUsage();

      return json({
        enabled: isApiKeyAuthEnabled(),
        keys: await listApiKeys(),
      });
    }

    if (url.pathname === '/api/api-keys' && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as any;
      if (!body?.name?.trim()) {
        return json({ error: 'A name is required so the key can be identified later.' }, 400);
      }

      const created = await createApiKey({
        name: body.name,
        expiresInDays: body.expiresInDays ?? null,
        allowedProviders: Array.isArray(body.allowedProviders) ? body.allowedProviders : [],
      });

      // The plaintext key is returned here and never again.
      return json(created, 201);
    }

    if (url.pathname === '/api/api-keys/settings' && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as any;
      const enabled = body?.enabled === true;

      if (enabled && (await listApiKeys()).filter((key) => !key.revoked).length === 0) {
        return json(
          { error: 'Create at least one API key before enforcing key authentication.' },
          400,
        );
      }

      await updateProxyConfig({
        apiKeys: { ...getProxyConfig().apiKeys, enabled },
      });

      console.log(`[ApiKeys] Gateway key enforcement ${enabled ? 'ENABLED' : 'DISABLED'}`);
      return json({ enabled });
    }

    const revokeMatch = url.pathname.match(/^\/api\/api-keys\/([^/]+)\/revoke$/);
    if (revokeMatch && req.method === 'POST') {
      const ok = await revokeApiKey(decodeURIComponent(revokeMatch[1]));
      return ok ? json({ ok: true }) : json({ error: 'Key not found' }, 404);
    }

    const deleteMatch = url.pathname.match(/^\/api\/api-keys\/([^/]+)$/);
    if (deleteMatch && req.method === 'DELETE') {
      const ok = await deleteApiKey(decodeURIComponent(deleteMatch[1]));
      return ok ? json({ ok: true }) : json({ error: 'Key not found' }, 404);
    }

    return json({ error: 'Unknown API key endpoint' }, 404);
  } catch (error: any) {
    console.error('[ApiKeys API] Request failed:', error);
    return json({ error: error?.message || String(error) }, 500);
  }
}
