import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useApiKeys, useConfig } from '@/hooks/useQueries';
import { api } from '@/lib/api';
import { CreatedApiKey } from '@/lib/types';
import { formatCount, formatTimestamp } from '@/lib/format';
import { ConfirmModal } from '@/components/shared/ConfirmModal';
import { KeyRound, Copy, Check, Trash2, ShieldCheck, ShieldOff, Plus } from 'lucide-react';

export const Route = createFileRoute('/api-keys')({
  component: ApiKeysPage,
});

function ApiKeysPage() {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useApiKeys();
  const { data: config } = useConfig();

  const [name, setName] = useState('');
  const [expiresInDays, setExpiresInDays] = useState('');
  const [freshKey, setFreshKey] = useState<CreatedApiKey | null>(null);
  const [copied, setCopied] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const notify = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['api-keys'] });

  const createMutation = useMutation({
    mutationFn: () =>
      api.post<CreatedApiKey>('/api/api-keys', {
        name,
        expiresInDays: expiresInDays ? parseInt(expiresInDays, 10) : null,
      }),
    onSuccess: (created) => {
      setFreshKey(created);
      setCopied(false);
      setName('');
      setExpiresInDays('');
      refresh();
    },
    onError: (err: any) => notify(err.message || 'Failed to create key', 'error'),
  });

  const toggleMutation = useMutation({
    mutationFn: (enabled: boolean) => api.post('/api/api-keys/settings', { enabled }),
    onSuccess: (_result, enabled) => {
      refresh();
      queryClient.invalidateQueries({ queryKey: ['config'] });
      notify(enabled ? 'Key authentication is now REQUIRED' : 'Key authentication disabled');
    },
    onError: (err: any) => notify(err.message || 'Failed to update setting', 'error'),
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => api.post(`/api/api-keys/${id}/revoke`),
    onSuccess: () => {
      refresh();
      notify('Key revoked');
    },
    onError: (err: any) => notify(err.message || 'Failed to revoke key', 'error'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/api/api-keys/${id}`),
    onSuccess: () => {
      refresh();
      notify('Key deleted');
    },
    onError: (err: any) => notify(err.message || 'Failed to delete key', 'error'),
  });

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-3 text-base-content/60">
        <span className="loading loading-spinner loading-md" />
        <span className="text-sm font-medium">Loading API keys...</span>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="alert alert-error text-xs font-semibold shadow-md">
        <span>Failed to load API keys: {error?.message || 'Unknown error'}</span>
      </div>
    );
  }

  const baseUrl = config?.baseUrl || window.location.origin;
  const activeKeys = data.keys.filter((key) => !key.revoked);

  return (
    <div className="space-y-6 text-base-content">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-base-300 pb-4">
        <div>
          <h1 className="text-xl font-extrabold tracking-tight">Gateway API Keys</h1>
          <p className="text-xs text-base-content/50 mt-0.5">
            Issue <code className="font-mono">sk-nou-…</code> keys so clients can authenticate against
            the LLM proxy routes.
          </p>
        </div>

        <label className="flex items-center gap-3 self-start bg-base-200 border border-base-300 rounded-xl px-4 py-2.5">
          <input
            type="checkbox"
            className="toggle toggle-sm toggle-primary"
            checked={data.enabled}
            disabled={toggleMutation.isPending}
            onChange={(event) => toggleMutation.mutate(event.target.checked)}
          />
          <span className="text-xs font-bold flex items-center gap-1.5">
            {data.enabled ? (
              <>
                <ShieldCheck className="w-3.5 h-3.5 text-success" /> Required
              </>
            ) : (
              <>
                <ShieldOff className="w-3.5 h-3.5 text-warning" /> Open access
              </>
            )}
          </span>
        </label>
      </div>

      {!data.enabled && (
        <div className="alert alert-warning text-xs font-semibold shadow-sm">
          <span>
            Key authentication is off — anyone who can reach <code>{baseUrl}</code> can use your
            providers. Create a key, point your clients at it, then flip the toggle.
          </span>
        </div>
      )}

      {freshKey && (
        <div className="card bg-base-200 border border-primary/40 shadow-sm">
          <div className="card-body p-5 space-y-3">
            <h3 className="card-title text-sm font-bold tracking-wide flex items-center gap-2">
              <KeyRound className="w-4 h-4 text-primary" />
              COPY YOUR KEY NOW
            </h3>
            <p className="text-xs text-base-content/60">
              This is the only time the full key is shown. Only its hash is stored.
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 bg-base-100 border border-base-300 rounded-lg px-3 py-2 font-mono text-xs break-all">
                {freshKey.key}
              </code>
              <button
                type="button"
                className="btn btn-sm btn-primary rounded-xl gap-1.5"
                onClick={() => {
                  navigator.clipboard.writeText(freshKey.key);
                  setCopied(true);
                }}
              >
                {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>

            <button
              type="button"
              className="btn btn-ghost btn-xs self-start"
              onClick={() => setFreshKey(null)}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      <div className="card bg-base-200 border border-base-300 shadow-sm">
        <div className="card-body p-5 space-y-4">
          <h3 className="card-title text-sm font-bold tracking-wide">CREATE A KEY</h3>

          <form
            className="grid grid-cols-1 sm:grid-cols-[2fr_1fr_auto] gap-3 items-end"
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim()) {
                createMutation.mutate();
              }
            }}
          >
            <div className="form-control w-full">
              <label className="label">
                <span className="label-text font-semibold text-xs text-base-content/75">
                  Name (also becomes the client ID in cost reports)
                </span>
              </label>
              <input
                type="text"
                required
                placeholder="claude-code-laptop"
                className="input input-bordered input-sm w-full bg-base-100 font-mono text-xs"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>

            <div className="form-control w-full">
              <label className="label">
                <span className="label-text font-semibold text-xs text-base-content/75">
                  Expires in days (optional)
                </span>
              </label>
              <input
                type="number"
                min="1"
                placeholder="never"
                className="input input-bordered input-sm w-full bg-base-100 font-mono text-xs"
                value={expiresInDays}
                onChange={(event) => setExpiresInDays(event.target.value)}
              />
            </div>

            <button
              type="submit"
              className="btn btn-sm btn-primary rounded-xl font-semibold gap-1.5"
              disabled={createMutation.isPending || !name.trim()}
            >
              {createMutation.isPending ? (
                <span className="loading loading-spinner loading-xs" />
              ) : (
                <Plus className="w-3.5 h-3.5" />
              )}
              Generate
            </button>
          </form>
        </div>
      </div>

      <div className="card bg-base-200 border border-base-300 shadow-sm">
        <div className="card-body p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="card-title text-sm font-bold tracking-wide">ISSUED KEYS</h3>
            <span className="text-[11px] text-base-content/50 font-mono">
              {activeKeys.length} active / {data.keys.length} total
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="table table-sm">
              <thead>
                <tr className="text-base-content/50 text-[10px] uppercase tracking-wider">
                  <th>Name</th>
                  <th>Key</th>
                  <th className="text-right">Requests</th>
                  <th>Last used</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.keys.map((key) => (
                  <tr key={key.id}>
                    <td className="font-semibold text-xs">{key.name}</td>
                    <td className="font-mono text-[11px] text-base-content/60">{key.keyPrefix}</td>
                    <td className="text-right font-mono text-xs">{formatCount(key.requestCount)}</td>
                    <td className="text-[11px] text-base-content/60">
                      {key.lastUsedAt ? formatTimestamp(key.lastUsedAt) : 'never'}
                    </td>
                    <td>
                      {key.revoked ? (
                        <span className="badge badge-xs badge-error font-bold">revoked</span>
                      ) : key.expiresAt && key.expiresAt < Date.now() ? (
                        <span className="badge badge-xs badge-warning font-bold">expired</span>
                      ) : (
                        <span className="badge badge-xs badge-success font-bold">active</span>
                      )}
                    </td>
                    <td className="text-right whitespace-nowrap">
                      {!key.revoked && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-xs text-warning"
                          onClick={() => revokeMutation.mutate(key.id)}
                        >
                          Revoke
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn-ghost btn-xs text-error"
                        onClick={() => setPendingDelete(key.id)}
                        title="Delete permanently"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
                {data.keys.length === 0 && (
                  <tr>
                    <td colSpan={6} className="text-center text-base-content/40 py-8 text-xs">
                      No keys yet — create one above.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <ConfirmModal
        isOpen={pendingDelete !== null}
        title="Delete API key"
        message="This permanently removes the key. Any client still using it will start getting 401s."
        confirmText="Delete"
        isDestructive
        onConfirm={() => {
          if (pendingDelete) {
            deleteMutation.mutate(pendingDelete);
          }
          setPendingDelete(null);
        }}
        onCancel={() => setPendingDelete(null)}
      />

      {toast && (
        <div className="toast toast-end toast-bottom z-50 p-4">
          <div
            className={`alert ${toast.type === 'error' ? 'alert-error' : 'alert-success'} text-xs font-semibold shadow-lg`}
          >
            <span>{toast.message}</span>
          </div>
        </div>
      )}
    </div>
  );
}
