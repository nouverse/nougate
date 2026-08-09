import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

export interface SessionUser {
  id: string;
  username: string;
  /** True until the account replaces the credential it was created with. */
  mustChangePassword: boolean;
}

export interface AuthState {
  /** The signed-in user, or null when there is no valid session. */
  user: SessionUser | null;
}

export const AUTH_QUERY_KEY = ['auth', 'session'];

/**
 * Read the current session. A 401 is a normal "signed out" answer here, not an
 * error, so it resolves instead of throwing.
 */
async function fetchSession(): Promise<AuthState> {
  const res = await fetch('/api/auth/me');

  if (res.status === 401) {
    return { user: null };
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
 * Exchange credentials for a session cookie.
 */
export async function login(username: string, password: string): Promise<void> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || 'Sign-in failed');
  }
}

export interface ProfileUpdate {
  currentPassword: string;
  /** Omit or leave empty to keep the current username. */
  newUsername?: string;
  /** Omit or leave empty to keep the current password. */
  newPassword?: string;
}

/**
 * Update the signed-in user's own username and/or password.
 */
export async function updateProfile(update: ProfileUpdate): Promise<SessionUser> {
  const res = await fetch('/api/auth/profile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(update),
  });

  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(body.error || 'Could not update your account');
  }

  return body.user;
}

/**
 * Drop the session cookie and reload into the login screen.
 */
export async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.reload();
}
