import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { KeyRound, LogOut } from 'lucide-react';
import { AUTH_QUERY_KEY, updateProfile, logout } from '@/hooks/useAuth';
import { AuthShell } from '@/components/auth/LoginScreen';

/**
 * Shown instead of the dashboard while an account still carries the credential
 * it was created with. The API enforces the same rule, so this is the UI half
 * of a block that cannot be skipped by navigating around it.
 *
 * The username is editable here too: the seeded account is called "admin", and
 * this is the natural moment to claim a real name — but it stays optional so it
 * never gets in the way of the mandatory part.
 */
export function AccountSetupScreen({ username }: { username: string }) {
  const queryClient = useQueryClient();
  const [newUsername, setNewUsername] = useState(username);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();

    if (newPassword !== confirmPassword) {
      setError('The two new passwords do not match.');
      return;
    }

    setBusy(true);
    setError(null);

    try {
      await updateProfile({
        // No current password: the session was just minted by proving it, and
        // the server exempts this one case for exactly that reason.
        newUsername: newUsername.trim() !== username ? newUsername.trim() : undefined,
        newPassword,
      });
      await queryClient.invalidateQueries({ queryKey: AUTH_QUERY_KEY });
    } catch (err: any) {
      setError(err?.message || 'Could not finish setting up the account');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell
      title="Finish setting up your account"
      subtitle={`Signed in as ${username}. This account still uses the password it was created with — choose a new one before continuing.`}
    >
      <form onSubmit={submit} className="space-y-3">
        <div className="form-control w-full">
          <label className="label py-1">
            <span className="label-text font-semibold text-xs text-base-content/75">
              Username
            </span>
            <span className="label-text-alt text-[10px] text-base-content/40">optional</span>
          </label>
          <input
            type="text"
            required
            pattern="[a-z0-9][a-z0-9._\-]{2,31}"
            autoComplete="username"
            className="input input-bordered input-sm w-full bg-base-100 font-mono text-xs"
            value={newUsername}
            onChange={(event) => setNewUsername(event.target.value.toLowerCase())}
          />
          <label className="label py-1">
            <span className="label-text-alt text-[10px] text-base-content/50">
              Keep it as-is, or pick your own name now.
            </span>
          </label>
        </div>

        <div className="divider my-0" />

        <div className="form-control w-full">
          <label className="label py-1">
            <span className="label-text font-semibold text-xs text-base-content/75">
              New password
            </span>
          </label>
          <input
            type="password"
            required
            autoFocus
            minLength={8}
            autoComplete="new-password"
            className="input input-bordered input-sm w-full bg-base-100 text-xs"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
          />
          <label className="label py-1">
            <span className="label-text-alt text-[10px] text-base-content/50">
              At least 8 characters, and not the default one.
            </span>
          </label>
        </div>

        <div className="form-control w-full">
          <label className="label py-1">
            <span className="label-text font-semibold text-xs text-base-content/75">
              Confirm new password
            </span>
          </label>
          <input
            type="password"
            required
            autoComplete="new-password"
            className="input input-bordered input-sm w-full bg-base-100 text-xs"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
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
          {busy ? (
            <span className="loading loading-spinner loading-xs" />
          ) : (
            <KeyRound className="w-4 h-4" />
          )}
          Save and continue
        </button>

        <button
          type="button"
          onClick={logout}
          className="btn btn-ghost btn-xs w-full gap-1.5 text-base-content/50"
        >
          <LogOut className="w-3 h-3" />
          Sign out
        </button>
      </form>
    </AuthShell>
  );
}
