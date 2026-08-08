import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCustomProviders, useCustomProvider, useInvalidateCustomProviders } from '@/hooks/useQueries';
import { api } from '@/lib/api';
import { CustomApiStyle, CustomProviderModel } from '@/lib/types';
import { ConfirmModal } from '@/components/shared/ConfirmModal';
import { CopyButton, ModelIdChip } from '@/components/shared/CopyButton';
import { formatTimestamp } from '@/lib/format';
import { Boxes, Plus, RefreshCw, Trash2, KeyRound, Save } from 'lucide-react';

export const Route = createFileRoute('/custom-providers')({
  component: CustomProvidersPage,
});

interface NewProviderForm {
  id: string;
  displayName: string;
  baseUrl: string;
  apiStyle: CustomApiStyle;
  apiKey: string;
  keyLabel: string;
  defaultInputPrice: string;
  defaultOutputPrice: string;
  autoLoadModels: boolean;
}

const EMPTY_FORM: NewProviderForm = {
  id: '',
  displayName: '',
  baseUrl: '',
  apiStyle: 'openai',
  apiKey: '',
  keyLabel: '',
  defaultInputPrice: '',
  defaultOutputPrice: '',
  autoLoadModels: true,
};

function CustomProvidersPage() {
  const queryClient = useQueryClient();
  const invalidate = useInvalidateCustomProviders();

  const { data: providers, isLoading } = useCustomProviders();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { data: detail } = useCustomProvider(selectedId);

  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<NewProviderForm>(EMPTY_FORM);
  const [newKey, setNewKey] = useState({ apiKey: '', label: '' });
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  // Land on the first provider so the page is never an empty right-hand pane.
  useEffect(() => {
    if (!selectedId && providers && providers.length > 0) {
      setSelectedId(providers[0].id);
    }
  }, [providers, selectedId]);

  const notify = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 5000);
  };

  const refreshDetail = () => {
    invalidate();
    if (selectedId) {
      queryClient.invalidateQueries({ queryKey: ['custom-providers', selectedId] });
    }
  };

  const createMutation = useMutation({
    mutationFn: () =>
      api.post<any>('/api/custom-providers', {
        id: form.id,
        displayName: form.displayName || form.id,
        baseUrl: form.baseUrl,
        apiStyle: form.apiStyle,
        apiKey: form.apiKey || undefined,
        keyLabel: form.keyLabel || undefined,
        defaultInputPrice: form.defaultInputPrice ? parseFloat(form.defaultInputPrice) : null,
        defaultOutputPrice: form.defaultOutputPrice ? parseFloat(form.defaultOutputPrice) : null,
        autoLoadModels: form.autoLoadModels,
      }),
    onSuccess: (result) => {
      const created = result.provider;
      setSelectedId(created.id);
      setShowCreate(false);
      setForm(EMPTY_FORM);
      invalidate();

      const sync = result.modelSync;
      if (sync?.error) {
        notify(`Provider created, but model discovery failed: ${sync.error}`, 'error');
      } else if (sync) {
        notify(`Provider created — imported ${sync.imported} model(s).`);
      } else {
        notify('Provider created.');
      }
    },
    onError: (err: any) => notify(err.message || 'Failed to create provider', 'error'),
  });

  const updateMutation = useMutation({
    mutationFn: (updates: Record<string, unknown>) =>
      api.post(`/api/custom-providers/${selectedId}`, updates),
    onSuccess: () => {
      refreshDetail();
      notify('Provider updated.');
    },
    onError: (err: any) => notify(err.message || 'Failed to update provider', 'error'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/api/custom-providers/${id}`),
    onSuccess: () => {
      setSelectedId(null);
      invalidate();
      notify('Provider deleted.');
    },
    onError: (err: any) => notify(err.message || 'Failed to delete provider', 'error'),
  });

  const addKeyMutation = useMutation({
    mutationFn: () => api.post(`/api/custom-providers/${selectedId}/keys`, newKey),
    onSuccess: () => {
      setNewKey({ apiKey: '', label: '' });
      refreshDetail();
      notify('API key added.');
    },
    onError: (err: any) => notify(err.message || 'Failed to add key', 'error'),
  });

  const removeKeyMutation = useMutation({
    mutationFn: (keyId: string) => api.delete(`/api/custom-providers/${selectedId}/keys/${keyId}`),
    onSuccess: () => {
      refreshDetail();
      notify('API key removed.');
    },
    onError: (err: any) => notify(err.message || 'Failed to remove key', 'error'),
  });

  const syncMutation = useMutation({
    mutationFn: () => api.post<any>(`/api/custom-providers/${selectedId}/sync-models`),
    onSuccess: (result) => {
      refreshDetail();
      notify(
        `Discovered ${result.discovered.length} model(s): imported ${result.imported}, kept ${result.skipped} existing.`,
      );
    },
    onError: (err: any) => notify(err.message || 'Model sync failed', 'error'),
  });

  const saveModelsMutation = useMutation({
    mutationFn: (models: Partial<CustomProviderModel>[]) =>
      api.post(`/api/custom-providers/${selectedId}/models`, { models }),
    onSuccess: () => {
      refreshDetail();
      notify('Models saved.');
    },
    onError: (err: any) => notify(err.message || 'Failed to save models', 'error'),
  });

  const removeModelMutation = useMutation({
    mutationFn: (modelId: string) =>
      api.delete(`/api/custom-providers/${selectedId}/models/${encodeURIComponent(modelId)}`),
    onSuccess: () => {
      refreshDetail();
      notify('Model removed.');
    },
    onError: (err: any) => notify(err.message || 'Failed to remove model', 'error'),
  });

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-3 text-base-content/60">
        <span className="loading loading-spinner loading-md" />
        <span className="text-sm font-medium">Loading custom providers...</span>
      </div>
    );
  }

  return (
    <div className="space-y-6 text-base-content min-w-0">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-base-300 pb-4">
        <div>
          <h1 className="text-xl font-extrabold tracking-tight">Custom Providers</h1>
          <p className="text-xs text-base-content/50 mt-0.5">
            Point Nougate at any OpenAI- or Anthropic-compatible endpoint and call it as{' '}
            <code className="font-mono">provider_id:model</code>.
          </p>
        </div>

        <button
          type="button"
          className="btn btn-sm btn-primary rounded-xl font-semibold gap-1.5 self-start"
          onClick={() => setShowCreate(!showCreate)}
        >
          <Plus className="w-3.5 h-3.5" />
          New provider
        </button>
      </div>

      {showCreate && (
        <div className="card bg-base-200 border border-primary/40 shadow-sm">
          <div className="card-body p-5 space-y-4 min-w-0">
            <h3 className="card-title text-sm font-bold tracking-wide flex items-center gap-2">
              <Boxes className="w-4 h-4 text-primary" />
              ADD A PROVIDER
            </h3>

            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                createMutation.mutate();
              }}
            >
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Field label="Provider ID" hint="Lowercase, becomes the model prefix — e.g. deepseek">
                  <input
                    type="text"
                    required
                    pattern="[a-z][a-z0-9_-]*"
                    placeholder="deepseek"
                    className="input input-bordered input-sm w-full bg-base-100 font-mono text-xs"
                    value={form.id}
                    onChange={(event) => setForm({ ...form, id: event.target.value.toLowerCase() })}
                  />
                </Field>

                <Field label="Display name" hint="Shown in the sidebar">
                  <input
                    type="text"
                    placeholder="DeepSeek"
                    className="input input-bordered input-sm w-full bg-base-100 text-xs"
                    value={form.displayName}
                    onChange={(event) => setForm({ ...form, displayName: event.target.value })}
                  />
                </Field>

                <Field label="Base URL" hint="Include the version path, e.g. https://api.deepseek.com/v1">
                  <input
                    type="url"
                    required
                    placeholder="https://api.deepseek.com/v1"
                    className="input input-bordered input-sm w-full bg-base-100 font-mono text-xs"
                    value={form.baseUrl}
                    onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
                  />
                </Field>

                <Field label="API style" hint="How the upstream expects requests and auth">
                  <select
                    className="select select-bordered select-sm w-full bg-base-100 text-xs"
                    value={form.apiStyle}
                    onChange={(event) =>
                      setForm({ ...form, apiStyle: event.target.value as CustomApiStyle })
                    }
                  >
                    <option value="openai">OpenAI — /chat/completions, Bearer token</option>
                    <option value="anthropic">Anthropic — /messages, x-api-key</option>
                  </select>
                </Field>

                <Field label="API key" hint="Stored in SQLite; add more later for rotation">
                  <input
                    type="password"
                    placeholder="sk-..."
                    className="input input-bordered input-sm w-full bg-base-100 font-mono text-xs"
                    value={form.apiKey}
                    onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
                  />
                </Field>

                <Field label="Key label" hint="Optional name for this key">
                  <input
                    type="text"
                    placeholder="primary"
                    className="input input-bordered input-sm w-full bg-base-100 text-xs"
                    value={form.keyLabel}
                    onChange={(event) => setForm({ ...form, keyLabel: event.target.value })}
                  />
                </Field>

                <Field label="Default input price" hint="USD per 1M tokens, used for cost tracking">
                  <input
                    type="number"
                    step="0.001"
                    placeholder="0.27"
                    className="input input-bordered input-sm w-full bg-base-100 font-mono text-xs"
                    value={form.defaultInputPrice}
                    onChange={(event) => setForm({ ...form, defaultInputPrice: event.target.value })}
                  />
                </Field>

                <Field label="Default output price" hint="USD per 1M tokens">
                  <input
                    type="number"
                    step="0.001"
                    placeholder="1.10"
                    className="input input-bordered input-sm w-full bg-base-100 font-mono text-xs"
                    value={form.defaultOutputPrice}
                    onChange={(event) => setForm({ ...form, defaultOutputPrice: event.target.value })}
                  />
                </Field>
              </div>

              <label className="label cursor-pointer justify-start gap-3">
                <input
                  type="checkbox"
                  className="toggle toggle-sm toggle-primary"
                  checked={form.autoLoadModels}
                  onChange={(event) => setForm({ ...form, autoLoadModels: event.target.checked })}
                />
                <span className="label-text font-semibold text-xs text-base-content/75">
                  Auto-load models from the upstream <code className="font-mono">/models</code> endpoint
                  (needs an API key)
                </span>
              </label>

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  className="btn btn-sm btn-ghost rounded-xl"
                  onClick={() => setShowCreate(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-sm btn-primary rounded-xl font-semibold"
                  disabled={createMutation.isPending}
                >
                  {createMutation.isPending ? (
                    <span className="loading loading-spinner loading-xs" />
                  ) : (
                    'Create provider'
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {(providers ?? []).length === 0 && !showCreate && (
        <div className="card bg-base-200 border border-base-300 shadow-sm">
          <div className="card-body p-10 items-center text-center gap-2">
            <Boxes className="w-8 h-8 text-base-content/20" />
            <span className="text-sm font-bold">No custom providers yet</span>
            <span className="text-xs text-base-content/50 max-w-md">
              Add one to route traffic through any OpenAI- or Anthropic-compatible API with your own
              key, pricing, and model list.
            </span>
          </div>
        </div>
      )}

      {(providers ?? []).length > 0 && (
        // min-w-0 on the grid children: without it a grid track defaults to
        // min-width:auto, so the wide models table stretches the column and
        // scrolls the whole page sideways instead of scrolling inside itself.
        <div className="grid grid-cols-1 lg:grid-cols-[240px_minmax(0,1fr)] gap-4 min-w-0">
          <div className="card bg-base-200 border border-base-300 shadow-sm h-fit min-w-0">
            <div className="card-body p-3 gap-1">
              {providers!.map((provider) => (
                <button
                  key={provider.id}
                  type="button"
                  className={`flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-semibold transition-all ${
                    selectedId === provider.id
                      ? 'bg-primary text-primary-content shadow-md'
                      : 'text-base-content/75 hover:bg-base-300'
                  }`}
                  onClick={() => setSelectedId(provider.id)}
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <span
                      className={`w-2 h-2 rounded-full shrink-0 ${
                        provider.enabled ? 'bg-success' : 'bg-base-content/30'
                      }`}
                    />
                    <span className="truncate">{provider.displayName}</span>
                  </span>
                  <span className="text-[10px] font-mono opacity-60 shrink-0">
                    {provider.modelCount ?? 0}m
                  </span>
                </button>
              ))}
            </div>
          </div>

          {detail && (
            <div className="space-y-4 min-w-0">
              <ProviderSettings
                detail={detail}
                onSave={(updates) => updateMutation.mutate(updates)}
                onDelete={() => setPendingDelete(detail.id)}
                isSaving={updateMutation.isPending}
              />

              <div className="card bg-base-200 border border-base-300 shadow-sm">
                <div className="card-body p-5 space-y-4 min-w-0">
                  <h3 className="card-title text-sm font-bold tracking-wide flex items-center gap-2">
                    <KeyRound className="w-4 h-4 text-primary" />
                    API KEYS ({detail.keys.length})
                  </h3>
                  <p className="text-xs text-base-content/50 -mt-2">
                    Keys rotate like accounts: the healthiest one wins, a 429 puts it in cooldown and
                    the next key takes over.
                  </p>

                  <div className="overflow-x-auto min-w-0">
                    <table className="table table-sm">
                      <thead>
                        <tr className="text-base-content/50 text-[10px] uppercase tracking-wider">
                          <th>Label</th>
                          <th>Key</th>
                          <th className="text-right">Health</th>
                          <th>Last used</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {detail.keys.map((key) => (
                          <tr key={key.id}>
                            <td className="font-semibold text-xs">{key.label}</td>
                            <td className="font-mono text-[11px] text-base-content/60">{key.apiKey}</td>
                            <td className="text-right font-mono text-xs">
                              {key.healthScore}
                              {key.cooldownUntil > Date.now() && (
                                <span className="badge badge-xs badge-warning ml-1.5 font-bold">
                                  cooldown
                                </span>
                              )}
                            </td>
                            <td className="text-[11px] text-base-content/60">
                              {key.lastUsed ? formatTimestamp(key.lastUsed) : 'never'}
                            </td>
                            <td className="text-right">
                              <button
                                type="button"
                                className="btn btn-ghost btn-xs text-error"
                                onClick={() => removeKeyMutation.mutate(key.id)}
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </td>
                          </tr>
                        ))}
                        {detail.keys.length === 0 && (
                          <tr>
                            <td colSpan={5} className="text-center text-base-content/40 py-6 text-xs">
                              No keys — requests to this provider will fail until you add one.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>

                  <form
                    className="flex flex-col sm:flex-row gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      addKeyMutation.mutate();
                    }}
                  >
                    <input
                      type="password"
                      required
                      placeholder="sk-..."
                      className="input input-bordered input-sm flex-1 bg-base-100 font-mono text-xs"
                      value={newKey.apiKey}
                      onChange={(event) => setNewKey({ ...newKey, apiKey: event.target.value })}
                    />
                    <input
                      type="text"
                      placeholder="label (optional)"
                      className="input input-bordered input-sm w-full sm:w-40 bg-base-100 text-xs"
                      value={newKey.label}
                      onChange={(event) => setNewKey({ ...newKey, label: event.target.value })}
                    />
                    <button
                      type="submit"
                      className="btn btn-sm btn-primary rounded-xl font-semibold"
                      disabled={addKeyMutation.isPending}
                    >
                      Add key
                    </button>
                  </form>
                </div>
              </div>

              <ModelEditor
                providerId={detail.id}
                models={detail.models}
                onSave={(models) => saveModelsMutation.mutate(models)}
                onRemove={(modelId) => removeModelMutation.mutate(modelId)}
                onSync={() => syncMutation.mutate()}
                isSyncing={syncMutation.isPending}
                isSaving={saveModelsMutation.isPending}
              />
            </div>
          )}
        </div>
      )}

      <ConfirmModal
        isOpen={pendingDelete !== null}
        title="Delete custom provider"
        message="This removes the provider along with its API keys and model definitions. Clients calling this prefix will stop working."
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
            className={`alert ${toast.type === 'error' ? 'alert-error' : 'alert-success'} text-xs font-semibold shadow-lg max-w-md`}
          >
            <span>{toast.message}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="form-control w-full">
      <label className="label">
        <span className="label-text font-semibold text-xs text-base-content/75">{label}</span>
      </label>
      {children}
      {hint && (
        <label className="label">
          <span className="label-text-alt text-[10px] text-base-content/50">{hint}</span>
        </label>
      )}
    </div>
  );
}

function ProviderSettings({
  detail,
  onSave,
  onDelete,
  isSaving,
}: {
  detail: any;
  onSave: (updates: Record<string, unknown>) => void;
  onDelete: () => void;
  isSaving: boolean;
}) {
  const [baseUrl, setBaseUrl] = useState(detail.baseUrl);
  const [displayName, setDisplayName] = useState(detail.displayName);
  const [apiStyle, setApiStyle] = useState<CustomApiStyle>(detail.apiStyle);
  const [enabled, setEnabled] = useState<boolean>(detail.enabled);

  // Re-seed the form whenever a different provider is selected.
  useEffect(() => {
    setBaseUrl(detail.baseUrl);
    setDisplayName(detail.displayName);
    setApiStyle(detail.apiStyle);
    setEnabled(detail.enabled);
  }, [detail.id, detail.baseUrl, detail.displayName, detail.apiStyle, detail.enabled]);

  return (
    <div className="card bg-base-200 border border-base-300 shadow-sm">
      <div className="card-body p-5 space-y-4 min-w-0">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h3 className="card-title text-sm font-bold tracking-wide flex-wrap">
            {detail.displayName}
            <span className="inline-flex items-center gap-1 ml-1">
              <code className="text-[11px] font-mono font-bold text-primary">{detail.id}:</code>
              <span className="text-[11px] font-normal text-base-content/40">model prefix</span>
              <CopyButton value={`${detail.id}:`} title={`Copy the "${detail.id}:" prefix`} />
            </span>
          </h3>
          <button type="button" className="btn btn-ghost btn-xs text-error gap-1.5" onClick={onDelete}>
            <Trash2 className="w-3.5 h-3.5" />
            Delete provider
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Display name">
            <input
              type="text"
              className="input input-bordered input-sm w-full bg-base-100 text-xs"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </Field>

          <Field label="Base URL">
            <input
              type="url"
              className="input input-bordered input-sm w-full bg-base-100 font-mono text-xs"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </Field>

          <Field label="API style">
            <select
              className="select select-bordered select-sm w-full bg-base-100 text-xs"
              value={apiStyle}
              onChange={(event) => setApiStyle(event.target.value as CustomApiStyle)}
            >
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic</option>
            </select>
          </Field>

          <div className="form-control w-full justify-end pb-2">
            <label className="label cursor-pointer justify-start gap-3">
              <input
                type="checkbox"
                className="toggle toggle-sm toggle-primary"
                checked={enabled}
                onChange={(event) => setEnabled(event.target.checked)}
              />
              <span className="label-text font-semibold text-xs text-base-content/75">
                Enabled (unregistering stops the prefix from resolving)
              </span>
            </label>
          </div>
        </div>

        <div className="flex justify-end">
          <button
            type="button"
            className="btn btn-sm btn-primary rounded-xl font-semibold gap-1.5"
            disabled={isSaving}
            onClick={() => onSave({ displayName, baseUrl, apiStyle, enabled })}
          >
            <Save className="w-3.5 h-3.5" />
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function ModelEditor({
  providerId,
  models,
  onSave,
  onRemove,
  onSync,
  isSyncing,
  isSaving,
}: {
  providerId: string;
  models: CustomProviderModel[];
  onSave: (models: Partial<CustomProviderModel>[]) => void;
  onRemove: (modelId: string) => void;
  onSync: () => void;
  isSyncing: boolean;
  isSaving: boolean;
}) {
  const [draft, setDraft] = useState<CustomProviderModel[]>(models);
  const [newModelId, setNewModelId] = useState('');

  useEffect(() => {
    setDraft(models);
  }, [models]);

  const patch = (modelId: string, updates: Partial<CustomProviderModel>) => {
    setDraft((current) =>
      current.map((model) => (model.modelId === modelId ? { ...model, ...updates } : model)),
    );
  };

  return (
    <div className="card bg-base-200 border border-base-300 shadow-sm">
      <div className="card-body p-5 space-y-4 min-w-0">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h3 className="card-title text-sm font-bold tracking-wide">MODELS ({draft.length})</h3>
          <div className="flex items-center gap-2">
            <CopyButton
              value={draft.map((model) => `${providerId}:${model.modelId}`).join('\n')}
              label={`Copy ${draft.length} ID${draft.length === 1 ? '' : 's'}`}
              className="border border-base-300"
              title="Copy every model ID, one per line"
            />
            <button
              type="button"
              className="btn btn-ghost btn-xs gap-1.5"
              onClick={onSync}
              disabled={isSyncing}
            >
              {isSyncing ? (
                <span className="loading loading-spinner loading-xs" />
              ) : (
                <RefreshCw className="w-3.5 h-3.5" />
              )}
              Auto-load from upstream
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary rounded-xl font-semibold gap-1.5"
              disabled={isSaving}
              onClick={() => onSave(draft)}
            >
              <Save className="w-3.5 h-3.5" />
              Save models
            </button>
          </div>
        </div>

        <div className="overflow-x-auto min-w-0">
          <table className="table table-sm">
            <thead>
              <tr className="text-base-content/50 text-[10px] uppercase tracking-wider">
                <th className="min-w-[16rem]">Model ID (send this as `model`)</th>
                <th>Upstream ID</th>
                <th className="text-right">Max out</th>
                <th className="text-right">$ / 1M in</th>
                <th className="text-right">$ / 1M out</th>
                <th className="text-center">Think</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {draft.map((model) => (
                <tr key={model.modelId}>
                  <td>
                    <ModelIdChip providerId={providerId} modelId={model.modelId} />
                  </td>
                  <td>
                    <input
                      type="text"
                      className="input input-bordered input-xs w-36 bg-base-100 font-mono text-[11px]"
                      value={model.upstreamModelId ?? ''}
                      onChange={(event) =>
                        patch(model.modelId, { upstreamModelId: event.target.value })
                      }
                    />
                  </td>
                  <td className="text-right">
                    <input
                      type="number"
                      className="input input-bordered input-xs w-24 bg-base-100 font-mono text-[11px] text-right"
                      value={model.maxOutputTokens}
                      onChange={(event) =>
                        patch(model.modelId, { maxOutputTokens: parseInt(event.target.value, 10) || 8192 })
                      }
                    />
                  </td>
                  <td className="text-right">
                    <input
                      type="number"
                      step="0.001"
                      placeholder="auto"
                      className="input input-bordered input-xs w-24 bg-base-100 font-mono text-[11px] text-right"
                      value={model.inputPricePer1M ?? ''}
                      onChange={(event) =>
                        patch(model.modelId, {
                          inputPricePer1M: event.target.value ? parseFloat(event.target.value) : null,
                        })
                      }
                    />
                  </td>
                  <td className="text-right">
                    <input
                      type="number"
                      step="0.001"
                      placeholder="auto"
                      className="input input-bordered input-xs w-24 bg-base-100 font-mono text-[11px] text-right"
                      value={model.outputPricePer1M ?? ''}
                      onChange={(event) =>
                        patch(model.modelId, {
                          outputPricePer1M: event.target.value ? parseFloat(event.target.value) : null,
                        })
                      }
                    />
                  </td>
                  <td className="text-center">
                    <input
                      type="checkbox"
                      className="checkbox checkbox-xs"
                      checked={model.isThinking}
                      onChange={(event) => patch(model.modelId, { isThinking: event.target.checked })}
                    />
                  </td>
                  <td className="text-right">
                    <button
                      type="button"
                      className="btn btn-ghost btn-xs text-error"
                      onClick={() => onRemove(model.modelId)}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
              {draft.length === 0 && (
                <tr>
                  <td colSpan={7} className="text-center text-base-content/40 py-6 text-xs">
                    No models. Use "Auto-load from upstream" or add one below.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <form
          className="flex flex-col sm:flex-row gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!newModelId.trim()) {
              return;
            }
            onSave([
              ...draft,
              {
                modelId: newModelId.trim(),
                displayName: newModelId.trim(),
                upstreamModelId: newModelId.trim(),
                maxOutputTokens: 8192,
              },
            ]);
            setNewModelId('');
          }}
        >
          <input
            type="text"
            placeholder="deepseek-v4-flash"
            className="input input-bordered input-sm flex-1 bg-base-100 font-mono text-xs"
            value={newModelId}
            onChange={(event) => setNewModelId(event.target.value)}
          />
          <button type="submit" className="btn btn-sm btn-ghost rounded-xl font-semibold gap-1.5">
            <Plus className="w-3.5 h-3.5" />
            Add model
          </button>
        </form>
      </div>
    </div>
  );
}
