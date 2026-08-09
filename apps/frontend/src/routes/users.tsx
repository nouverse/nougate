import { createFileRoute, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { ConfirmModal } from '@/components/shared/ConfirmModal';
import { formatTimestamp } from '@/lib/format';
import { Users as UsersIcon, Plus, Trash2 } from 'lucide-react';

export const Route = createFileRoute('/users')({
  component: UsersPage,
});

interface DashboardUser {
  id: string;
  username: string;
  mustChangePassword: boolean;
  createdAt: number;
  lastLoginAt: number | null;
  isCurrent: boolean;
}

function UsersPage() {
  const queryClient = useQueryClient();

  const { data: users, isLoading, error } = useQuery({
    queryKey: ['users'],
    queryFn: () => api.get<DashboardUser[]>('/api/users'),
  });

  const [newUser, setNewUser] = useState({ username: '', password: '' });
  const [pendingDelete, setPendingDelete] = useState<DashboardUser | null>(null);
  const [resetFor, setResetFor] = useState<DashboardUser | null>(null);
  const [resetPassword, setResetPassword] = useState('');
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  const notify = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['users'] });

  const createMutation = useMutation({
    mutationFn: () => api.post('/api/users', newUser),
    onSuccess: () => {
      notify(`User "${newUser.username}" created — they must set their own password on first sign-in.`);
      setNewUser({ username: '', password: '' });
      refresh();
    },
    onError: (err: any) => notify(err.message || 'Could not create the user', 'error'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/api/users/${id}`),
    onSuccess: () => {
      notify('User deleted');
      refresh();
    },
    onError: (err: any) => notify(err.message || 'Could not delete the user', 'error'),
  });

  const resetMutation = useMutation({
    mutationFn: ({ id, password }: { id: string; password: string }) =>
      api.post(`/api/users/${id}/password`, { password }),
    onSuccess: () => {
      notify('Password reset');
      setResetFor(null);
      setResetPassword('');
      refresh();
    },
    onError: (err: any) => notify(err.message || 'Could not reset the password', 'error'),
  });

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-3 text-base-content/60">
        <span className="loading loading-spinner loading-md" />
        <span className="text-sm font-medium">Loading users...</span>
      </div>
    );
  }

  if (error || !users) {
    return (
      <div className="alert alert-error text-xs font-semibold shadow-md">
        <span>Failed to load users: {error?.message || 'Unknown error'}</span>
      </div>
    );
  }

  return (
    <div className="space-y-6 text-base-content min-w-0">
      <div className="border-b border-base-300 pb-4">
        <h1 className="text-xl font-extrabold tracking-tight">Users</h1>
        <p className="text-xs text-base-content/50 mt-0.5">
          Everyone listed here has full dashboard access, including managing other users. To
          change your own username or password, go to{' '}
          <Link to={'/settings' as any} className="link link-primary font-semibold">
            Account Settings
          </Link>
          .
        </p>
      </div>

      <div className="card bg-base-200 border border-base-300 shadow-sm min-w-0">
        <div className="card-body p-5 space-y-3 min-w-0">
          <h3 className="card-title text-sm font-bold tracking-wide flex items-center gap-2">
            <UsersIcon className="w-4 h-4 text-primary" />
            REGISTERED USERS ({users.length})
          </h3>

          <div className="overflow-x-auto min-w-0">
            <table className="table table-sm">
              <thead>
                <tr className="text-base-content/50 text-[10px] uppercase tracking-wider">
                  <th>Username</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th>Last sign-in</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id}>
                    <td className="font-semibold text-xs">
                      {user.username}
                      {user.isCurrent && (
                        <span className="badge badge-xs badge-primary ml-2 font-bold">you</span>
                      )}
                    </td>
                    <td>
                      {user.mustChangePassword ? (
                        <span className="badge badge-xs badge-warning font-bold">
                          must set password
                        </span>
                      ) : (
                        <span className="badge badge-xs badge-success font-bold">active</span>
                      )}
                    </td>
                    <td className="text-[11px] text-base-content/60">
                      {formatTimestamp(user.createdAt)}
                    </td>
                    <td className="text-[11px] text-base-content/60">
                      {user.lastLoginAt ? formatTimestamp(user.lastLoginAt) : 'never'}
                    </td>
                    <td className="text-right whitespace-nowrap">
                      <button
                        type="button"
                        className="btn btn-ghost btn-xs"
                        onClick={() => {
                          setResetFor(user);
                          setResetPassword('');
                        }}
                      >
                        Reset password
                      </button>
                      {!user.isCurrent && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-xs text-error"
                          onClick={() => setPendingDelete(user)}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {resetFor && (
            <form
              className="flex flex-col sm:flex-row gap-2 border-t border-base-300 pt-3"
              onSubmit={(event) => {
                event.preventDefault();
                resetMutation.mutate({ id: resetFor.id, password: resetPassword });
              }}
            >
              <span className="text-xs font-semibold self-center whitespace-nowrap">
                New password for <code className="font-mono">{resetFor.username}</code>:
              </span>
              <input
                type="password"
                required
                minLength={8}
                autoFocus
                className="input input-bordered input-sm flex-1 bg-base-100 font-mono text-xs"
                value={resetPassword}
                onChange={(event) => setResetPassword(event.target.value)}
              />
              <button type="submit" className="btn btn-sm btn-primary rounded-xl font-semibold">
                Set
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost rounded-xl"
                onClick={() => setResetFor(null)}
              >
                Cancel
              </button>
            </form>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 min-w-0">
        <div className="card bg-base-200 border border-base-300 shadow-sm min-w-0">
          <div className="card-body p-5 space-y-4 min-w-0">
            <h3 className="card-title text-sm font-bold tracking-wide flex items-center gap-2">
              <Plus className="w-4 h-4 text-primary" />
              ADD A USER
            </h3>
            <p className="text-xs text-base-content/50 -mt-2">
              The password you set here is temporary — they will be asked to replace it the first
              time they sign in.
            </p>

            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                createMutation.mutate();
              }}
            >
              <div className="form-control w-full">
                <label className="label py-1">
                  <span className="label-text font-semibold text-xs text-base-content/75">
                    Username
                  </span>
                </label>
                <input
                  type="text"
                  required
                  pattern="\S{3,254}"
                  title="At least 3 characters, no spaces"
                  placeholder="teammate"
                  className="input input-bordered input-sm w-full bg-base-100 font-mono text-xs"
                  value={newUser.username}
                  onChange={(event) =>
                    setNewUser({ ...newUser, username: event.target.value.toLowerCase() })
                  }
                />
                <label className="label py-1">
                  <span className="label-text-alt text-[10px] text-base-content/50">
                    Anything without spaces — an email address works too.
                  </span>
                </label>
              </div>

              <div className="form-control w-full">
                <label className="label py-1">
                  <span className="label-text font-semibold text-xs text-base-content/75">
                    Temporary password
                  </span>
                </label>
                <input
                  type="password"
                  required
                  minLength={8}
                  className="input input-bordered input-sm w-full bg-base-100 font-mono text-xs"
                  value={newUser.password}
                  onChange={(event) => setNewUser({ ...newUser, password: event.target.value })}
                />
              </div>

              <button
                type="submit"
                className="btn btn-sm btn-primary rounded-xl font-semibold w-full"
                disabled={createMutation.isPending}
              >
                {createMutation.isPending ? (
                  <span className="loading loading-spinner loading-xs" />
                ) : (
                  'Create user'
                )}
              </button>
            </form>
          </div>
        </div>

      </div>

      <ConfirmModal
        isOpen={pendingDelete !== null}
        title={`Delete "${pendingDelete?.username}"`}
        message="This removes the account and immediately revokes any session it has open."
        confirmText="Delete"
        isDestructive
        onConfirm={() => {
          if (pendingDelete) {
            deleteMutation.mutate(pendingDelete.id);
          }
          setPendingDelete(null);
        }}
        onCancel={() => setPendingDelete(null)}
      />

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
