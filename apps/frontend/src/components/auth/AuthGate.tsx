import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { LoginScreen } from '@/components/auth/LoginScreen';
import { AccountSetupScreen } from '@/components/auth/AccountSetupScreen';
import { host } from '@/lib/host';

interface Props {
  children: React.ReactNode;
}

/**
 * Hold the dashboard back until the session is known. The static bundle is
 * public, so this is a UX gate — the API guard is what actually protects data.
 */
export function AuthGate({ children }: Props) {
  const { data, isPending, error, refetch } = useAuth();

  if (isPending) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-base-100">
        <span className="loading loading-spinner loading-md text-primary" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-base-100 font-sans p-6">
        <div className="w-full max-w-sm text-center">
          <AlertTriangle className="w-8 h-8 text-warning mx-auto mb-4" />
          <h1 className="text-sm font-bold text-base-content mb-2">Gateway unreachable</h1>
          <p className="text-xs text-base-content/60 leading-relaxed mb-6">
            {error instanceof Error ? error.message : 'Could not verify your session.'}
          </p>
          <button onClick={() => refetch()} className="btn btn-sm btn-primary font-semibold">
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!data?.user) {
    // Inside a host the sign-in is the host's, and a login form here would ask for a password the
    // person may never have had — the host vouches for them, or nobody does. The host's own session
    // has ended, so send the whole page back to it rather than this frame.
    if (host.embedded) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-base-100 font-sans p-6">
          <div className="w-full max-w-sm text-center">
            <AlertTriangle className="w-8 h-8 text-warning mx-auto mb-4" />
            <h1 className="text-sm font-bold text-base-content mb-2">Signed out</h1>
            <p className="text-xs text-base-content/60 leading-relaxed mb-6">
              Your session has ended. Sign in again to manage the LLM Gateway.
            </p>
            <button
              onClick={() => (window.top ?? window).location.reload()}
              className="btn btn-sm btn-primary font-semibold"
            >
              Sign in
            </button>
          </div>
        </div>
      );
    }
    return <LoginScreen />;
  }

  // The API blocks every other endpoint until this is done, so showing the
  // dashboard here would only render a wall of failed requests.
  if (data.user.mustChangePassword) {
    return <AccountSetupScreen username={data.user.username} />;
  }

  return <>{children}</>;
}
