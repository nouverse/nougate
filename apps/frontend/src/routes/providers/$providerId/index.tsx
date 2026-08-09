import type { ReactNode } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useProviderDetail } from '@/hooks/useQueries';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { QuotaGrid } from '@/components/providers/antigravity/QuotaGrid';
import { ModelRegistryTable } from '@/components/providers/shared/ModelRegistryTable';
import { AntigravityAccountsTab } from '@/components/providers/antigravity/AntigravityAccountsTab';
import { CopilotAccountsTab } from '@/components/providers/copilot/CopilotAccountsTab';
import { ProviderOverviewTab } from '@/components/providers/shared/ProviderOverviewTab';
import { JsonEditor } from '@/components/shared/JsonEditor';
import { EmptyState } from '@/components/shared/EmptyState';
import { CopyButton } from '@/components/shared/CopyButton';
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

  const allQuotasMap = new Map<string, { sumRemainingFraction: number; count: number; minRemainingFraction: number; worstQuota: any }>();
  detail.accounts.forEach((acc) => {
    if (acc.quota && Array.isArray(acc.quota)) {
      acc.quota.forEach((q: any) => {
        const existing = allQuotasMap.get(q.limitName);
        if (!existing) {
          allQuotasMap.set(q.limitName, {
            sumRemainingFraction: q.remainingFraction,
            count: 1,
            minRemainingFraction: q.remainingFraction,
            worstQuota: { ...q },
          });
        } else {
          existing.sumRemainingFraction += q.remainingFraction;
          existing.count += 1;
          if (q.remainingFraction < existing.minRemainingFraction) {
            existing.minRemainingFraction = q.remainingFraction;
            existing.worstQuota = { ...q };
          }
        }
      });
    }
  });

  const mergedQuotas = Array.from(allQuotasMap.values()).map((entry) => {
    const avg = entry.sumRemainingFraction / entry.count;
    return {
      ...entry.worstQuota,
      remainingFraction: avg,
      quotaLeft: `${Math.round(avg * 100)}%`,
    };
  });

  // Quotas are a provider capability, not a universal one — only Antigravity
  // reports them today. The tab appears when there is something in it, so the
  // other providers do not open onto an empty panel.
  const hasQuota = mergedQuotas.length > 0;
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
          <div className="badge badge-neutral bg-base-300 text-base-content/75 border-0 font-semibold gap-1 py-3 px-3">
            <Users className="w-3.5 h-3.5 text-primary" />
            {detail.accounts.length} accounts
          </div>
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

        {activeTab === 'quota' && <QuotaGrid quotas={mergedQuotas} />}

        {activeTab === 'accounts' && (
          providerId === 'copilot' ? (
            <CopilotAccountsTab accounts={detail.accounts} refreshQueries={refreshQueries} />
          ) : (
            <AntigravityAccountsTab accounts={detail.accounts} refreshQueries={refreshQueries} />
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
