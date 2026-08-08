import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

export interface AuthState {
  /** False when the gateway runs without dashboard authentication configured. */
  authEnabled: boolean;
  /** The signed-in Google account, or null when there is no valid session. */
  email: string | null;
}

const AUTH_QUERY_KEY = ['auth', 'session'];

/**
 * Read the current session. A 401 is a normal "signed out" answer here, not an
 * error, so it resolves instead of throwing.
 */
async function fetchSession(): Promise<AuthState> {
  const res = await fetch('/api/auth/me');

  if (res.status === 401) {
    return { authEnabled: true, email: null };
  }

  if (!res.ok) {
    throw new Error(`Could not reach the gateway (${res.status})`);
  }

  return res.json();
}

export function useAuth() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: AUTH_QUERY_KEY,
    queryFn: fetchSession,
    staleTime: 60000,
    retry: false,
  });

  useEffect(() => {
    const handleUnauthorized = () => {
      queryClient.invalidateQueries({ queryKey: AUTH_QUERY_KEY });
    };

    window.addEventListener('nougate:unauthorized', handleUnauthorized);
    return () => window.removeEventListener('nougate:unauthorized', handleUnauthorized);
  }, [queryClient]);

  return query;
}

/**
 * Send the browser to the Google consent screen, returning to the current page.
 */
export function startLogin() {
  const next = `${window.location.pathname}${window.location.search}`;
  window.location.href = `/api/auth/login?next=${encodeURIComponent(next)}`;
}

/**
 * Drop the session cookie and reload into the login screen.
 */
export async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.reload();
}
