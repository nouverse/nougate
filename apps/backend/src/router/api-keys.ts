import {
  createApiKey,
  deleteApiKey,
  flushApiKeyUsage,
  listApiKeys,
  renameApiKey,
  revokeApiKey,
  rotateApiKey,
  updateApiKeyExpiry,
} from '@/auth/api-keys';

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

      return json({ keys: await listApiKeys() });
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

    const revokeMatch = url.pathname.match(/^\/api\/api-keys\/([^/]+)\/revoke$/);
    if (revokeMatch && req.method === 'POST') {
      const ok = await revokeApiKey(decodeURIComponent(revokeMatch[1]));
      return ok ? json({ ok: true }) : json({ error: 'Key not found' }, 404);
    }

    const rotateMatch = url.pathname.match(/^\/api\/api-keys\/([^/]+)\/rotate$/);
    if (rotateMatch && req.method === 'POST') {
      const result = await rotateApiKey(decodeURIComponent(rotateMatch[1]));
      if (!result.ok) {
        return result.reason === 'not-found'
          ? json({ error: 'Key not found' }, 404)
          : json({ error: 'A revoked key cannot be rotated. Create a new key instead.' }, 409);
      }

      // Same contract as creation: the plaintext appears here and never again.
      return json(result.key);
    }

    const expiryMatch = url.pathname.match(/^\/api\/api-keys\/([^/]+)\/expiry$/);
    if (expiryMatch && req.method === 'PATCH') {
      const body = (await req.json().catch(() => ({}))) as any;
      const expiresAt = body?.expiresAt ?? null;
      if (expiresAt !== null && (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt))) {
        return json(
          { error: 'expiresAt must be a millisecond timestamp, or null for no expiry.' },
          400,
        );
      }

      const updated = await updateApiKeyExpiry(decodeURIComponent(expiryMatch[1]), expiresAt);
      return updated ? json(updated) : json({ error: 'Key not found' }, 404);
    }

    const nameMatch = url.pathname.match(/^\/api\/api-keys\/([^/]+)\/name$/);
    if (nameMatch && req.method === 'PATCH') {
      const body = (await req.json().catch(() => ({}))) as any;
      if (typeof body?.name !== 'string' || !body.name.trim()) {
        return json({ error: 'A name is required so the key can be identified later.' }, 400);
      }
      if (body.name.trim().length > 64) {
        return json({ error: 'A key name is at most 64 characters.' }, 400);
      }

      const updated = await renameApiKey(decodeURIComponent(nameMatch[1]), body.name);
      return updated ? json(updated) : json({ error: 'Key not found' }, 404);
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
