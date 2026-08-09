import type { ReactNode } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useProviderDetail } from '@/hooks/useQueries';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { QuotaGrid } from '@/components/providers/shared/QuotaGrid';
import { ModelRegistryTable } from '@/components/providers/shared/ModelRegistryTable';
import { AntigravityAccountsTab } from '@/components/providers/antigravity/AntigravityAccountsTab';
import { CopilotAccountsTab } from '@/components/providers/copilot/CopilotAccountsTab';
import { ApiKeyAccountsTab } from '@/components/providers/shared/ApiKeyAccountsTab';
import { ProviderOverviewTab } from '@/components/providers/shared/ProviderOverviewTab';
import { JsonEditor } from '@/components/shared/JsonEditor';
import { EmptyState } from '@/components/shared/EmptyState';
import { CopyButton } from '@/components/shared/CopyButton';
import { AccountLimitBadge } from '@/components/shared/AccountLimitBadge';
import { Users, Cpu, Gauge, Settings2, BarChart2 } from 'lucide-react';

type Tab = 'overview' | 'quota' | 'accounts' | 'models' | 'config';

interface SearchParams {
  tab?: Tab;
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

  const refreshQueries = () => {
    queryClient.invalidateQueries({ queryKey: ['providers', providerId] });
  };

  const configMutation = useMutation({
    mutationFn: (newConfig: any) => api.post(`/api/providers/${providerId}/config`, newConfig),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['providers', providerId] });
      // showToast('Provider configuration updated!');
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

  const handleTabChange = (t: Tab) => {
    navigate({
      search: { tab: t } as any,
    });
  };

  // Declared by the backend from the provider contract — never inferred from
  // the provider id or from whether data happens to be loaded. A provider that
  // implements getQuotas() gets this tab; one that does not, never sees it.
  const hasQuota = detail.capabilities?.quota ?? false;
  const accountFlow = detail.capabilities?.accountFlow ?? null;
  const activeTab: Tab = tab === 'quota' && !hasQuota ? 'overview' : tab;

  const tabs: Array<{ id: Tab; label: string; icon: ReactNode }> = [
    { id: 'overview', label: 'Overview', icon: <BarChart2 className="w-4 h-4 mr-1.5 text-primary" /> },
    ...(hasQuota
      ? [{ id: 'quota' as Tab, label: 'Quota', icon: <Gauge className="w-4 h-4 mr-1.5 text-warning" /> }]
      : []),
    { id: 'accounts', label: 'Accounts', icon: <Users className="w-4 h-4 mr-1.5 text-secondary" /> },
    { id: 'models', label: 'Model Specs', icon: <Cpu className="w-4 h-4 mr-1.5 text-accent" /> },
    { id: 'config', label: 'Provider Config', icon: <Settings2 className="w-4 h-4 mr-1.5" /> },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row justify-between items-stretch md:items-center gap-4 bg-base-200 p-5 rounded-2xl border border-base-300 text-base-content">
        <div className="min-w-0">
          <h1 className="text-xl font-extrabold capitalize tracking-tight flex items-center gap-2">
            {detail.displayName} Portal
          </h1>
          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
            <span className="text-xs text-base-content/50">Model prefix:</span>
            <code className="font-mono text-xs font-bold text-primary">{detail.id}:</code>
            <span className="text-xs text-base-content/40">
              — call any model below as <code className="font-mono">{detail.id}:model-id</code>
            </span>
            <CopyButton value={`${detail.id}:`} title={`Copy the "${detail.id}:" prefix`} />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <AccountLimitBadge count={detail.accounts.length} limit={detail.accountLimit} />
          <div className="badge badge-neutral bg-base-300 text-base-content/75 border-0 font-semibold gap-1 py-3 px-3">
            <Cpu className="w-3.5 h-3.5 text-secondary" />
            {detail.models.length} models
          </div>
        </div>
      </div>

      <div className="tabs tabs-lifted border-b border-base-300 text-base-content overflow-x-auto">
        {tabs.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={`tab font-semibold whitespace-nowrap ${
              activeTab === entry.id ? 'tab-active text-primary' : 'text-base-content/60'
            }`}
            onClick={() => handleTabChange(entry.id)}
          >
            {entry.icon}
            {entry.label}
          </button>
        ))}
      </div>

      <div className="mt-4">
        {activeTab === 'overview' && (
          <ProviderOverviewTab
            providerId={detail.id}
            accounts={detail.accounts}
            models={detail.models}
          />
        )}

        {activeTab === 'quota' && <QuotaGrid quotas={detail.quotas ?? []} />}

        {/* Which form to show is the provider's declaration, not a guess from its
            id — the old `id === 'copilot' ? … : Antigravity` fallback handed every
            custom provider a Google OAuth dialog it had no use for. */}
        {activeTab === 'accounts' && (
          accountFlow === 'api-key' ? (
            <ApiKeyAccountsTab
              providerId={detail.id}
              accounts={detail.accounts}
              refreshQueries={refreshQueries}
            />
          ) : accountFlow === 'device-code' ? (
            <CopilotAccountsTab accounts={detail.accounts} refreshQueries={refreshQueries} />
          ) : accountFlow === 'oauth-redirect' ? (
            <AntigravityAccountsTab accounts={detail.accounts} refreshQueries={refreshQueries} />
          ) : (
            <EmptyState message="This provider does not support adding accounts from the dashboard." />
          )
        )}

        {activeTab === 'models' && (
          <div className="space-y-4">
            <h3 className="text-xs font-bold tracking-wider text-base-content/40 uppercase px-1 text-base-content">
              MODEL SPECIFICATIONS
            </h3>
            {detail.models.length === 0 ? (
              <EmptyState message="No models configured in the local provider registry." />
            ) : (
              <ModelRegistryTable models={detail.models} providerId={detail.id} />
            )}
          </div>
        )}

        {activeTab === 'config' && (
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
    </div>
  );
}
