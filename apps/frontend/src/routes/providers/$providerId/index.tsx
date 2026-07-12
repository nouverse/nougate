import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useProviderDetail } from '../../../hooks/useQueries';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../lib/api';
import { ConfirmModal } from '../../../components/shared/ConfirmModal';
import { QuotaGrid } from '../../../components/providers/antigravity/QuotaGrid';
import { AccountsTable } from '../../../components/providers/antigravity/AccountsTable';
import { AccountCard } from '../../../components/providers/antigravity/AccountCard';
import { ModelRegistryTable } from '../../../components/providers/antigravity/ModelRegistryTable';
import { JsonEditor } from '../../../components/shared/JsonEditor';
import { EmptyState } from '../../../components/shared/EmptyState';
import { Plus, Users, Cpu, Settings2, BarChart2, Shield } from 'lucide-react';

interface SearchParams {
  tab?: 'overview' | 'accounts' | 'models' | 'config';
}

export const Route = createFileRoute('/providers/$providerId/')({
  component: ProviderPage,
  validateSearch: (search: Record<string, unknown>): SearchParams => {
    return {
      tab: (search.tab as any) || 'overview',
    };
  },
});

function ProviderPage() {
  const { providerId } = Route.useParams();
  const { tab = 'overview' } = Route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: detail, isLoading, error } = useProviderDetail(providerId);

  const [deleteEmail, setDeleteEmail] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  const refreshQueries = () => {
    queryClient.invalidateQueries({ queryKey: ['providers', providerId] });
  };

  const [showAuthModal, setShowAuthModal] = useState(false);
  const [authUrl, setAuthUrl] = useState('');
  const [pastedUrl, setPastedUrl] = useState('');
  const [isAuthenticating, setIsAuthenticating] = useState(false);

  const handleOpenAuthModal = async () => {
    try {
      const res = await api.post<{ redirectUrl: string }>(`/api/providers/${providerId}/accounts/add`);
      if (res?.redirectUrl) {
        setAuthUrl(res.redirectUrl);
        setPastedUrl('');
        setShowAuthModal(true);
      } else {
        showToast('OAuth flow initialization failed.');
      }
    } catch (err: any) {
      showToast(`Error initializing auth: ${err.message}`);
    }
  };

  const handleAuthenticate = async () => {
    if (!pastedUrl.trim()) return;
    setIsAuthenticating(true);
    
    let code = pastedUrl.trim();
    try {
      if (code.startsWith('http') || code.includes('?')) {
        const urlObj = new URL(code);
        code = urlObj.searchParams.get('code') || code;
      }
    } catch {
      // Ignored
    }

    try {
      const res = await api.post<{ success: boolean; email?: string; error?: string }>(
        `/api/providers/${providerId}/accounts/add`,
        { code }
      );
      if (res?.success) {
        showToast(`Account ${res.email || ''} authenticated successfully!`);
        setShowAuthModal(false);
        refreshQueries();
      } else if (res?.error) {
        showToast(`Auth failed: ${res.error}`);
      } else {
        showToast('Authentication failed.');
      }
    } catch (err: any) {
      showToast(`Auth error: ${err.message}`);
    } finally {
      setIsAuthenticating(false);
    }
  };

  const cooldownMutation = useMutation({
    mutationFn: (email: string) => api.post(`/api/accounts/${email}/cooldown`, { pool: 'cli' }),
    onSuccess: () => {
      showToast('Cooldown triggered for account!');
      refreshQueries();
    },
  });

  const rediscoverMutation = useMutation({
    mutationFn: (email: string) => api.post(`/api/accounts/${email}/project/rediscover`),
    onSuccess: () => {
      showToast('Project rediscovered!');
      refreshQueries();
    },
    onError: (err: any) => {
      showToast(`Rediscovery failed: ${err.message}`);
    },
  });

  const resetMutation = useMutation({
    mutationFn: (email: string) => api.post(`/api/accounts/${email}/reset`),
    onSuccess: () => {
      showToast('Account state reset successfully!');
      refreshQueries();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (email: string) => api.delete(`/api/accounts/${email}`),
    onSuccess: () => {
      showToast('Account deleted successfully!');
      setDeleteEmail(null);
      refreshQueries();
    },
  });

  const configMutation = useMutation({
    mutationFn: (newConfig: any) => api.post(`/api/providers/${providerId}/config`, newConfig),
    onSuccess: () => {
      showToast('Provider configuration updated!');
      refreshQueries();
    },
    onError: (err: any) => {
      showToast(`Save failed: ${err.message}`);
    },
  });

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-3 text-base-content/60">
        <span className="loading loading-spinner loading-md" />
        <span className="text-sm font-medium font-semibold">Loading provider details...</span>
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div className="alert alert-error text-xs font-semibold shadow-md">
        <span>Failed to load provider detail: {error?.message || 'Unknown error'}</span>
      </div>
    );
  }

  const handleTabChange = (t: SearchParams['tab']) => {
    navigate({
      search: { tab: t } as any,
    });
  };

  const allQuotasMap = new Map<string, any>();
  detail.accounts.forEach((acc) => {
    if (acc.quota && Array.isArray(acc.quota)) {
      acc.quota.forEach((q: any) => {
        const existing = allQuotasMap.get(q.limitName);
        if (!existing || q.remainingFraction < existing.remainingFraction) {
          allQuotasMap.set(q.limitName, q);
        }
      });
    }
  });

  const mergedQuotas = Array.from(allQuotasMap.values());

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row justify-between items-stretch md:items-center gap-4 bg-base-200 p-5 rounded-2xl border border-base-300 text-base-content">
        <div>
          <h1 className="text-xl font-extrabold capitalize tracking-tight flex items-center gap-2">
            {detail.displayName} Portal
          </h1>
          <p className="text-xs text-base-content/50 mt-0.5 font-mono animate-pulse">
            Provider Identifier: {detail.id}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="badge badge-neutral bg-base-300 text-base-content/75 border-0 font-semibold gap-1 py-3 px-3">
            <Users className="w-3.5 h-3.5 text-primary" />
            {detail.accounts.length} accounts
          </div>
          <div className="badge badge-neutral bg-base-300 text-base-content/75 border-0 font-semibold gap-1 py-3 px-3">
            <Cpu className="w-3.5 h-3.5 text-secondary" />
            {detail.models.length} models
          </div>
          <button
            type="button"
            className="btn btn-sm btn-primary rounded-xl font-semibold gap-1.5 shadow-md shadow-primary/10 hover:scale-105 transition-transform"
            onClick={handleOpenAuthModal}
            disabled={isAuthenticating}
          >
            {isAuthenticating ? (
              <span className="loading loading-spinner loading-xs" />
            ) : (
              <>
                <Plus className="w-4 h-4" />
                Add Account
              </>
            )}
          </button>
        </div>
      </div>

      <div className="tabs tabs-lifted border-b border-base-300 text-base-content">
        <button
          type="button"
          className={`tab font-semibold ${tab === 'overview' ? 'tab-active text-primary' : 'text-base-content/60'}`}
          onClick={() => handleTabChange('overview')}
        >
          <BarChart2 className="w-4 h-4 mr-1.5 text-primary" />
          Overview
        </button>
        <button
          type="button"
          className={`tab font-semibold ${tab === 'accounts' ? 'tab-active text-primary' : 'text-base-content/60'}`}
          onClick={() => handleTabChange('accounts')}
        >
          <Users className="w-4 h-4 mr-1.5 text-secondary" />
          Accounts
        </button>
        <button
          type="button"
          className={`tab font-semibold ${tab === 'models' ? 'tab-active text-primary' : 'text-base-content/60'}`}
          onClick={() => handleTabChange('models')}
        >
          <Cpu className="w-4 h-4 mr-1.5 text-accent" />
          Model Specs
        </button>
        <button
          type="button"
          className={`tab font-semibold ${tab === 'config' ? 'tab-active text-primary' : 'text-base-content/60'}`}
          onClick={() => handleTabChange('config')}
        >
          <Settings2 className="w-4 h-4 mr-1.5" />
          Provider Config
        </button>
      </div>

      <div className="mt-4">
        {tab === 'overview' && (
          <div className="space-y-6">
            {mergedQuotas.length > 0 ? (
              <QuotaGrid quotas={mergedQuotas} />
            ) : (
              <EmptyState message="No system quotas detected. Quotas will populate once accounts are successfully verified." />
            )}
          </div>
        )}

        {tab === 'accounts' && (
          <div className="space-y-4">
            <div className="flex justify-between items-center px-1 text-base-content">
              <h3 className="text-xs font-bold tracking-wider text-base-content/40 uppercase">
                ACCOUNTS POOL
              </h3>
              
              <button
                className="btn btn-sm btn-primary rounded-xl font-semibold gap-1.5"
                onClick={handleOpenAuthModal}
                disabled={isAuthenticating}
              >
                {isAuthenticating ? (
                  <span className="loading loading-spinner loading-xs" />
                ) : (
                  <>
                    <Plus className="w-4 h-4" />
                    Add Account
                  </>
                )}
              </button>
            </div>

            {detail.accounts.length === 0 ? (
              <EmptyState message="No accounts registered for this provider yet. Use the 'Add Account' button to configure one." />
            ) : (
              <>
                <div className="hidden lg:block">
                  <AccountsTable
                    accounts={detail.accounts}
                    onCooldown={(email) => cooldownMutation.mutate(email)}
                    onRediscover={(email) => rediscoverMutation.mutate(email)}
                    onReset={(email) => resetMutation.mutate(email)}
                    onDelete={(email) => setDeleteEmail(email)}
                  />
                </div>

                <div className="block lg:hidden space-y-4">
                  {detail.accounts.map((acc) => (
                    <AccountCard
                      key={acc.email}
                      account={acc}
                      onCooldown={(email) => cooldownMutation.mutate(email)}
                      onRediscover={(email) => rediscoverMutation.mutate(email)}
                      onReset={(email) => resetMutation.mutate(email)}
                      onDelete={(email) => setDeleteEmail(email)}
                    />
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {tab === 'models' && (
          <div className="space-y-4">
            <h3 className="text-xs font-bold tracking-wider text-base-content/40 uppercase px-1 text-base-content">
              MODEL SPECIFICATIONS
            </h3>
            {detail.models.length === 0 ? (
              <EmptyState message="No models configured in the local provider registry." />
            ) : (
              <ModelRegistryTable models={detail.models} />
            )}
          </div>
        )}

        {tab === 'config' && (
          <div className="space-y-4 text-base-content">
            <h3 className="text-xs font-bold tracking-wider text-base-content/40 uppercase px-1">
              PROVIDER SETTINGS
            </h3>
            <div className="card bg-base-200 border border-base-300 shadow-sm p-5">
              <JsonEditor
                value={detail.config}
                onSave={(newVal) => configMutation.mutate(newVal)}
                isSaving={configMutation.isPending}
              />
            </div>
          </div>
        )}
      </div>

      <ConfirmModal
        isOpen={deleteEmail !== null}
        title="Delete Account?"
        message={`Are you sure you want to delete the account ${deleteEmail}? This action will revoke its access tokens and clear its rotation history.`}
        confirmText="Delete Account"
        isDestructive={true}
        onConfirm={() => deleteEmail && deleteMutation.mutate(deleteEmail)}
        onCancel={() => setDeleteEmail(null)}
      />

      {/* Manual OAuth modal */}
      <dialog className={`modal ${showAuthModal ? 'modal-open' : ''}`} onClose={() => setShowAuthModal(false)}>
        <div className="modal-box rounded-2xl border border-base-300 shadow-xl bg-base-100 max-w-md text-base-content">
          <h3 className="font-extrabold text-lg flex items-center gap-2">
            <Shield className="w-5 h-5 text-primary animate-pulse" />
            Add Google Account
          </h3>
          <p className="text-xs text-base-content/50 mt-1 font-sans">
            Google OAuth requires a local port redirect. Follow these manual steps to authenticate.
          </p>

          <div className="mt-5 space-y-4 font-sans">
            <div className="flex gap-3 items-start">
              <span className="badge badge-primary font-bold mt-0.5">1</span>
              <div className="flex-1">
                <span className="text-xs font-bold block mb-1">Authorization Link</span>
                <a
                  href={authUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn btn-sm btn-primary rounded-xl font-bold w-full gap-1.5 flex items-center justify-center shadow shadow-primary/20 hover:scale-[1.02] transition-transform"
                >
                  <Plus className="w-4 h-4" />
                  Sign In with Google
                </a>
              </div>
            </div>

            <div className="flex gap-3 items-start">
              <span className="badge badge-neutral bg-base-300 text-base-content/75 border-0 font-bold mt-0.5">2</span>
              <div className="flex-1">
                <span className="text-xs font-bold block">Complete Consent</span>
                <p className="text-[10px] text-base-content/40 mt-0.5 leading-relaxed">
                  Log in to your Google Account. Once finished, your browser will attempt to load a failed local URL (e.g. `http://localhost:3000/oauth-callback?code=...`).
                </p>
              </div>
            </div>

            <div className="flex gap-3 items-start">
              <span className="badge badge-neutral bg-base-300 text-base-content/75 border-0 font-bold mt-0.5">3</span>
              <div className="flex-1">
                <span className="text-xs font-bold block mb-1">Paste Redirect URL</span>
                <textarea
                  className="textarea textarea-bordered bg-base-300 font-mono text-xs w-full h-24 focus:outline-none placeholder-base-content/20 leading-relaxed border-base-300"
                  placeholder="Paste the entire redirected localhost URL here..."
                  value={pastedUrl}
                  onChange={(e) => setPastedUrl(e.target.value)}
                />
              </div>
            </div>
          </div>

          <div className="modal-action mt-6 gap-2">
            <button
              type="button"
              className="btn btn-sm btn-ghost rounded-xl text-xs font-bold"
              onClick={() => setShowAuthModal(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary rounded-xl text-xs font-bold gap-1"
              onClick={handleAuthenticate}
              disabled={isAuthenticating || !pastedUrl.trim()}
            >
              {isAuthenticating ? (
                <span className="loading loading-spinner loading-xs" />
              ) : (
                'Authenticate'
              )}
            </button>
          </div>
        </div>
        <form method="dialog" className="modal-backdrop">
          <button type="button" onClick={() => setShowAuthModal(false)}>close</button>
        </form>
      </dialog>

      {toast && (
        <div className="toast toast-end toast-bottom z-50 p-4">
          <div className="alert alert-info text-xs font-semibold shadow-lg text-neutral-content">
            <span>{toast}</span>
          </div>
        </div>
      )}
    </div>
  );
}
