import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Shield, LogIn } from 'lucide-react';
import { AUTH_QUERY_KEY, login } from '@/hooks/useAuth';

/**
 * The shared framing used by both the sign-in and the forced password change
 * screens, so they read as one flow.
 */
export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-base-100 font-sans p-6">
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-center gap-3 mb-8">
          <div className="bg-primary text-primary-content p-2 rounded-xl">
            <Shield className="w-6 h-6" />
          </div>
          <div className="text-left">
            <span className="font-extrabold text-base-content text-xl tracking-wider block leading-none">
              NOUGATE
            </span>
            <span className="block text-[10px] text-base-content/40 font-mono tracking-widest mt-1">
              NOUVERSE AI GATEWAY
            </span>
          </div>
        </div>

        <div className="bg-base-200 border border-base-300 rounded-2xl p-8">
          <h1 className="text-sm font-bold text-base-content mb-2">{title}</h1>
          <p className="text-xs text-base-content/60 leading-relaxed mb-6">{subtitle}</p>
          {children}
        </div>

        {footer && (
          <p className="text-[10px] text-base-content/40 font-mono mt-6 text-center">{footer}</p>
        )}
      </div>
    </div>
  );
}

export function LoginScreen() {
  const queryClient = useQueryClient();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      await login(username, password);
      await queryClient.invalidateQueries({ queryKey: AUTH_QUERY_KEY });
    } catch (err: any) {
      setError(err?.message || 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell
      title="Sign in to continue"
      subtitle="This dashboard is restricted to registered users."
      footer="Ask an administrator for an account"
    >
      <form onSubmit={submit} className="space-y-3">
        <div className="form-control w-full">
          <label className="label py-1">
            <span className="label-text font-semibold text-xs text-base-content/75">Username</span>
          </label>
          <input
            type="text"
            required
            autoFocus
            autoComplete="username"
            className="input input-bordered input-sm w-full bg-base-100 text-xs"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
        </div>

        <div className="form-control w-full">
          <label className="label py-1">
            <span className="label-text font-semibold text-xs text-base-content/75">Password</span>
          </label>
          <input
            type="password"
            required
            autoComplete="current-password"
            className="input input-bordered input-sm w-full bg-base-100 text-xs"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>

        {error && (
          <div className="alert alert-error text-xs font-semibold py-2">
            <span>{error}</span>
          </div>
        )}

        <button
          type="submit"
          className="btn btn-primary btn-sm w-full gap-2 font-semibold mt-2"
          disabled={busy}
        >
          {busy ? <span className="loading loading-spinner loading-xs" /> : <LogIn className="w-4 h-4" />}
          Sign in
        </button>
      </form>
    </AuthShell>
  );
}
