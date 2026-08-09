import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AUTH_QUERY_KEY, updateProfile, useAuth, logout } from '@/hooks/useAuth';
import { formatTimestamp } from '@/lib/format';
import { UserCog, KeyRound, LogOut, ShieldCheck } from 'lucide-react';

export const Route = createFileRoute('/settings')({
  component: AccountSettingsPage,
});

/**
 * The signed-in user's own account. Managing *other* accounts lives on the
 * Users page — keeping them apart means a routine password change never sits
 * one mis-click away from deleting a colleague.
 */
function AccountSettingsPage() {
  const queryClient = useQueryClient();
  const { data: auth } = useAuth();
  const currentUsername = auth?.user?.username ?? '';

  const [username, setUsername] = useState(currentUsername);
  const [usernamePassword, setUsernamePassword] = useState('');

  const [passwords, setPasswords] = useState({ current: '', next: '', confirm: '' });

  const [busy, setBusy] = useState<'username' | 'password' | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  // Seed the field once the session has loaded.
  useEffect(() => {
    setUsername(currentUsername);
  }, [currentUsername]);

  const notify = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };

  const submitUsername = async (event: React.FormEvent) => {
    event.preventDefault();

    if (username.trim() === currentUsername) {
      notify('That is already your username.', 'error');
      return;
    }

    setBusy('username');
    try {
      const updated = await updateProfile({
        currentPassword: usernamePassword,
        newUsername: username.trim(),
      });
      await queryClient.invalidateQueries({ queryKey: AUTH_QUERY_KEY });
      setUsernamePassword('');
      notify(`You are now signed in as "${updated.username}".`);
    } catch (err: any) {
      notify(err?.message || 'Could not change your username', 'error');
    } finally {
      setBusy(null);
    }
  };

  const submitPassword = async (event: React.FormEvent) => {
    event.preventDefault();

    if (passwords.next !== passwords.confirm) {
      notify('The two new passwords do not match.', 'error');
      return;
    }

    setBusy('password');
    try {
      await updateProfile({
        currentPassword: passwords.current,
        newPassword: passwords.next,
      });
      await queryClient.invalidateQueries({ queryKey: AUTH_QUERY_KEY });
      setPasswords({ current: '', next: '', confirm: '' });
      notify('Your password has been changed.');
    } catch (err: any) {
      notify(err?.message || 'Could not change your password', 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-6 text-base-content min-w-0">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-base-300 pb-4">
        <div>
          <h1 className="text-xl font-extrabold tracking-tight">Account Settings</h1>
          <p className="text-xs text-base-content/50 mt-0.5">
            Your own sign-in details. To manage other people's accounts, use the Users page.
          </p>
        </div>

        <button
          type="button"
          onClick={logout}
          className="btn btn-sm btn-ghost rounded-xl font-semibold gap-1.5 self-start"
        >
          <LogOut className="w-3.5 h-3.5" />
          Sign out
        </button>
      </div>

      <div className="card bg-base-200 border border-base-300 shadow-sm min-w-0">
        <div className="card-body p-5 flex-row items-center gap-4 flex-wrap">
          <div className="bg-primary text-primary-content p-2.5 rounded-xl">
            <UserCog className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <span className="font-mono font-bold text-sm block truncate">{currentUsername}</span>
            <span className="text-[11px] text-base-content/50">
              Administrator · every signed-in user has full access
            </span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 min-w-0">
        <div className="card bg-base-200 border border-base-300 shadow-sm min-w-0">
          <div className="card-body p-5 space-y-4 min-w-0">
            <h3 className="card-title text-sm font-bold tracking-wide flex items-center gap-2">
              <UserCog className="w-4 h-4 text-primary" />
              CHANGE USERNAME
            </h3>
            <p className="text-xs text-base-content/50 -mt-2">
              You will sign in with the new name from now on. Your password stays the same.
            </p>

            <form onSubmit={submitUsername} className="space-y-3">
              <div className="form-control w-full">
                <label className="label py-1">
                  <span className="label-text font-semibold text-xs text-base-content/75">
                    New username
                  </span>
                </label>
                <input
                  type="text"
                  required
                  pattern="[a-z0-9][a-z0-9._\-]{2,31}"
                  className="input input-bordered input-sm w-full bg-base-100 font-mono text-xs"
                  value={username}
                  onChange={(event) => setUsername(event.target.value.toLowerCase())}
                />
                <label className="label py-1">
                  <span className="label-text-alt text-[10px] text-base-content/50">
                    3–32 chars: lowercase letters, digits, dot, dash or underscore.
                  </span>
                </label>
              </div>

              <div className="form-control w-full">
                <label className="label py-1">
                  <span className="label-text font-semibold text-xs text-base-content/75">
                    Current password
                  </span>
                </label>
                <input
                  type="password"
                  required
                  autoComplete="current-password"
                  className="input input-bordered input-sm w-full bg-base-100 text-xs"
                  value={usernamePassword}
                  onChange={(event) => setUsernamePassword(event.target.value)}
                />
                <label className="label py-1">
                  <span className="label-text-alt text-[10px] text-base-content/50">
                    Confirms it is really you, not just an open browser tab.
                  </span>
                </label>
              </div>

              <button
                type="submit"
                className="btn btn-sm btn-primary rounded-xl font-semibold w-full gap-1.5"
                disabled={busy !== null}
              >
                {busy === 'username' ? (
                  <span className="loading loading-spinner loading-xs" />
                ) : (
                  <ShieldCheck className="w-3.5 h-3.5" />
                )}
                Update username
              </button>
            </form>
          </div>
        </div>

        <div className="card bg-base-200 border border-base-300 shadow-sm min-w-0">
          <div className="card-body p-5 space-y-4 min-w-0">
            <h3 className="card-title text-sm font-bold tracking-wide flex items-center gap-2">
              <KeyRound className="w-4 h-4 text-primary" />
              CHANGE PASSWORD
            </h3>
            <p className="text-xs text-base-content/50 -mt-2">
              At least 8 characters. Your other sessions keep working.
            </p>

            <form onSubmit={submitPassword} className="space-y-3">
              <input
                type="password"
                required
                autoComplete="current-password"
                placeholder="Current password"
                className="input input-bordered input-sm w-full bg-base-100 text-xs"
                value={passwords.current}
                onChange={(event) => setPasswords({ ...passwords, current: event.target.value })}
              />
              <input
                type="password"
                required
                minLength={8}
                autoComplete="new-password"
                placeholder="New password"
                className="input input-bordered input-sm w-full bg-base-100 text-xs"
                value={passwords.next}
                onChange={(event) => setPasswords({ ...passwords, next: event.target.value })}
              />
              <input
                type="password"
                required
                autoComplete="new-password"
                placeholder="Confirm new password"
                className="input input-bordered input-sm w-full bg-base-100 text-xs"
                value={passwords.confirm}
                onChange={(event) => setPasswords({ ...passwords, confirm: event.target.value })}
              />

              <button
                type="submit"
                className="btn btn-sm btn-primary rounded-xl font-semibold w-full gap-1.5"
                disabled={busy !== null}
              >
                {busy === 'password' ? (
                  <span className="loading loading-spinner loading-xs" />
                ) : (
                  <ShieldCheck className="w-3.5 h-3.5" />
                )}
                Update password
              </button>
            </form>
          </div>
        </div>
      </div>

      {auth?.user && (
        <p className="text-[10px] text-base-content/40 font-mono">
          Session issued for {auth.user.username}
          {auth.user.mustChangePassword ? ' · password change outstanding' : ''}
          {` · loaded ${formatTimestamp(Date.now())}`}
        </p>
      )}

      {toast && (
        <div className="toast toast-end toast-bottom z-50 p-4">
          <div
            className={`alert ${toast.type === 'error' ? 'alert-error' : 'alert-success'} text-xs font-semibold shadow-lg max-w-md`}
          >
            <span>{toast.message}</span>
          </div>
        </div>
      )}
    </div>
  );
}
