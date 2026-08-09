import { getActiveUser } from '@/auth/guard';
import { AuthError, createUser, deleteUser, listUsers, setPassword } from '@/auth/users';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function fail(error: unknown): Response {
  if (error instanceof AuthError) {
    return json({ error: error.message }, error.status);
  }
  console.error('[Users API] Request failed:', error);
  return json({ error: (error as any)?.message || String(error) }, 500);
}

/**
 * Dashboard user management.
 *
 * Every signed-in user is an administrator, so no extra role check is needed —
 * reaching this handler already means the dashboard guard let the request past.
 * Returns null when the path is not a users route.
 */
export async function handleUsersRoute(req: Request, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/users')) {
    return null;
  }

  const current = getActiveUser(req);
  if (!current) {
    return json({ error: 'Sign in first.' }, 401);
  }

  try {
    if (url.pathname === '/api/users' && req.method === 'GET') {
      return json(
        listUsers().map((user) => ({ ...user, isCurrent: user.id === current.id })),
      );
    }

    if (url.pathname === '/api/users' && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as any;
      // New accounts start with a forced password change, so the creator never
      // ends up knowing the credential the user settles on.
      const user = await createUser(
        String(body?.username ?? ''),
        String(body?.password ?? ''),
        body?.mustChangePassword !== false,
      );
      console.log(`[Users] ${current.username} created user "${user.username}"`);
      return json(user, 201);
    }

    const resetMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/password$/);
    if (resetMatch && req.method === 'POST') {
      const targetId = decodeURIComponent(resetMatch[1]);
      const body = (await req.json().catch(() => ({}))) as any;

      await setPassword(targetId, String(body?.password ?? ''));
      console.log(`[Users] ${current.username} reset the password for user ${targetId}`);
      return json({ ok: true });
    }

    const deleteMatch = url.pathname.match(/^\/api\/users\/([^/]+)$/);
    if (deleteMatch && req.method === 'DELETE') {
      const targetId = decodeURIComponent(deleteMatch[1]);

      if (targetId === current.id) {
        return json({ error: 'You cannot delete the account you are signed in with.' }, 409);
      }

      deleteUser(targetId);
      console.log(`[Users] ${current.username} deleted user ${targetId}`);
      return json({ ok: true });
    }

    return json({ error: 'Unknown users endpoint' }, 404);
  } catch (error) {
    return fail(error);
  }
}
