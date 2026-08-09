import { createFileRoute, Link } from '@tanstack/react-router';
import { BarList } from '@/components/metrics/BarList';
import { StatTile } from '@/components/metrics/StatTile';
import {
  useApiKeys,
  useConfig,
  useModelCatalog,
  useProviders,
} from '@/hooks/useQueries';
import { formatCount } from '@/lib/format';
import type { Provider } from '@/lib/types';
import {
  Activity,
  ArrowRight,
  Boxes,
  Cpu,
  KeyRound,
  PlayCircle,
  Sparkles,
  Users,
  Workflow,
} from 'lucide-react';
import { NougateMark } from '@/components/brand/NougateMark';

export const Route = createFileRoute('/')({
  component: OverviewPage,
});

/**
 * Hero summary for the dashboard landing page.
 */
function OverviewHero({
  strategy,
  activeGatewayKeys,
  registeredModels,
  totalProviders,
  topModelProvider,
}: {
  strategy: string;
  activeGatewayKeys: number;
  registeredModels: number;
  totalProviders: number;
  topModelProvider: Provider | null;
}) {
  return (
    <div className="card bg-base-200 border border-base-300 shadow-sm overflow-hidden">
      <div className="card-body p-6 lg:p-7 gap-6">
        <div className="flex flex-col xl:flex-row gap-6 xl:items-start">
          <div className="flex-1 space-y-4">
            <div className="flex items-start gap-4">
              <NougateMark className="w-16 h-16 shrink-0" />

              <div className="space-y-2">
                <div>
                  <h1 className="text-2xl lg:text-3xl font-extrabold tracking-tight text-base-content">
                    Overview
                  </h1>
                  <p className="text-sm text-base-content/60 mt-1 max-w-3xl leading-relaxed">
                    Monitor gateway coverage, jump into the most important tools,
                    and keep an eye on how provider capacity is distributed across
                    the fleet.
                  </p>
                </div>

                <div className="flex flex-wrap gap-2">
                  <span className="badge badge-primary badge-sm font-semibold gap-1.5 py-3 px-3">
                    <Workflow className="w-3.5 h-3.5" />
                    {strategy}
                  </span>
                  <span className="badge badge-neutral bg-base-300 border-0 badge-sm font-semibold gap-1.5 py-3 px-3">
                    <KeyRound className="w-3.5 h-3.5" />
                    {formatCount(activeGatewayKeys)} active gateway keys
                  </span>
                  <span className="badge badge-neutral bg-base-300 border-0 badge-sm font-semibold gap-1.5 py-3 px-3">
                    <Cpu className="w-3.5 h-3.5" />
                    {formatCount(registeredModels)} callable models
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 xl:grid-cols-1 gap-3 xl:w-80">
            <div className="rounded-2xl border border-base-300 bg-base-100/70 p-4">
              <span className="text-[10px] font-bold uppercase tracking-wider text-base-content/45">
                Providers Online
              </span>
              <div className="text-2xl font-black font-mono text-base-content mt-1">
                {formatCount(totalProviders)}
              </div>
              <p className="text-[11px] text-base-content/50 mt-1">
                Every registered provider is available from the dashboard.
              </p>
            </div>

            <div className="rounded-2xl border border-base-300 bg-base-100/70 p-4">
              <span className="text-[10px] font-bold uppercase tracking-wider text-base-content/45">
                Lead Catalog
              </span>
              <div className="text-base font-bold text-base-content mt-1 truncate">
                {topModelProvider?.displayName ?? 'No providers'}
              </div>
              <p className="text-[11px] text-base-content/50 mt-1">
                {topModelProvider
                  ? `${formatCount(topModelProvider.modelCount)} models available`
                  : 'Add a provider to start routing traffic.'}
              </p>
            </div>

            <div className="rounded-2xl border border-base-300 bg-base-100/70 p-4">
              <span className="text-[10px] font-bold uppercase tracking-wider text-base-content/45">
                Operator Focus
              </span>
              <div className="text-base font-bold text-base-content mt-1">
                Metrics, keys, and testing
              </div>
              <p className="text-[11px] text-base-content/50 mt-1">
                The main flows are one click away from this landing page.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Fast navigation into the most common operator actions.
 */
function QuickActionsPanel() {
  const actions = [
    {
      title: 'Token Metrics',
      description: 'Inspect spend, savings, request volume, and latency trends.',
      to: '/tokens' as const,
      icon: <Activity className="w-4 h-4 text-primary" />,
    },
    {
      title: 'API Keys',
      description: 'Create, revoke, and audit the keys that clients use.',
      to: '/api-keys' as const,
      icon: <KeyRound className="w-4 h-4 text-primary" />,
    },
    {
      title: 'API Playground',
      description: 'Send a live request through the gateway and inspect the response.',
      to: '/playground' as const,
      icon: <PlayCircle className="w-4 h-4 text-primary" />,
    },
  ];

  return (
    <div className="card bg-base-200 border border-base-300 shadow-sm">
      <div className="card-body p-5 space-y-4">
        <div>
          <h2 className="text-sm font-bold tracking-wide text-base-content">
            Quick Actions
          </h2>
          <p className="text-xs text-base-content/50 mt-1">
            The most common operator workflows start here.
          </p>
        </div>

        <div className="space-y-3">
          {actions.map((action) => (
            <Link
              key={action.title}
              to={action.to}
              className="flex items-center justify-between gap-3 rounded-2xl border border-base-300 bg-base-100/70 px-4 py-3 hover:border-primary/30 hover:bg-base-100 transition-colors"
            >
              <div className="flex items-start gap-3 min-w-0">
                <div className="mt-0.5 shrink-0">{action.icon}</div>
                <div className="min-w-0">
                  <div className="font-semibold text-sm text-base-content">
                    {action.title}
                  </div>
                  <p className="text-[11px] text-base-content/50 leading-relaxed">
                    {action.description}
                  </p>
                </div>
              </div>
              <ArrowRight className="w-4 h-4 text-base-content/35 shrink-0" />
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Provider card with a clearer breakdown of capacity share.
 */
function ProviderCard({
  provider,
  totalAccounts,
  totalModels,
}: {
  provider: Provider;
  totalAccounts: number;
  totalModels: number;
}) {
  const modelShare = totalModels > 0 ? (provider.modelCount / totalModels) * 100 : 0;
  const accountShare = totalAccounts > 0 ? (provider.accountCount / totalAccounts) * 100 : 0;

  return (
    <div className="card bg-base-200 border border-base-300 shadow-sm hover:border-primary/20 hover:shadow-md transition-all">
      <div className="card-body p-5 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="font-bold text-base text-base-content truncate">
              {provider.displayName}
            </h3>
            <span className="text-[10px] font-mono text-base-content/40 block mt-0.5">
              {provider.id}
            </span>
          </div>

          <div className="flex flex-wrap justify-end gap-2 shrink-0">
            <span className="badge badge-success badge-sm font-semibold tracking-wide">
              Online
            </span>
            <span className="badge badge-neutral bg-base-300 border-0 badge-sm font-semibold tracking-wide">
              {provider.isCustom ? 'Custom' : 'Built-in'}
            </span>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-2xl bg-base-300/40 p-3 text-center">
            <span className="text-[10px] font-bold text-base-content/45 uppercase tracking-wider block">
              Accounts
            </span>
            <span className="text-lg font-extrabold font-mono text-base-content mt-1 block">
              {formatCount(provider.accountCount)}
            </span>
          </div>
          <div className="rounded-2xl bg-base-300/40 p-3 text-center">
            <span className="text-[10px] font-bold text-base-content/45 uppercase tracking-wider block">
              Models
            </span>
            <span className="text-lg font-extrabold font-mono text-base-content mt-1 block">
              {formatCount(provider.modelCount)}
            </span>
          </div>
        </div>

        <div className="space-y-3">
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-3 text-[11px]">
              <span className="font-semibold text-base-content/70">
                Model share
              </span>
              <span className="font-mono text-base-content/55">
                {modelShare.toFixed(1)}%
              </span>
            </div>
            <progress
              className="progress progress-primary w-full h-2"
              value={Math.max(modelShare, 0)}
              max="100"
            />
          </div>

          <div className="space-y-1">
            <div className="flex items-center justify-between gap-3 text-[11px]">
              <span className="font-semibold text-base-content/70">
                Account ratio
              </span>
              <span className="font-mono text-base-content/55">
                {accountShare.toFixed(1)}%
              </span>
            </div>
            <progress
              className="progress progress-secondary w-full h-2"
              value={Math.max(accountShare, 0)}
              max="100"
            />
          </div>
        </div>

        <div className="card-actions justify-end">
          <Link
            to="/providers/$providerId"
            params={{ providerId: provider.id }}
            className="btn btn-primary btn-sm rounded-xl font-semibold gap-1.5"
          >
            Manage
            <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      </div>
    </div>
  );
}

/**
 * Dashboard landing page with an operational snapshot and quick actions.
 */
function OverviewPage() {
  const { data: providers, isLoading, error } = useProviders();
  const { data: config } = useConfig();
  const { data: apiKeys } = useApiKeys();
  const { data: modelCatalog } = useModelCatalog();

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-3 text-base-content/60">
        <span className="loading loading-spinner loading-md" />
        <span className="text-sm font-medium">Loading system metrics...</span>
      </div>
    );
  }

  if (error || !providers) {
    return (
      <div className="alert alert-error text-xs font-semibold shadow-md">
        <span>Failed to load system data: {error?.message || 'Unknown error'}</span>
      </div>
    );
  }

  const now = Date.now();
  const totalProviders = providers.length;
  const totalAccounts = providers.reduce((acc, curr) => acc + curr.accountCount, 0);
  const totalModels = providers.reduce((acc, curr) => acc + curr.modelCount, 0);
  const gatewayKeyCount = apiKeys?.keys.length ?? 0;
  const activeGatewayKeys =
    apiKeys?.keys.filter((key) => !key.revoked && (!key.expiresAt || key.expiresAt > now)).length ?? 0;
  const revokedGatewayKeys = apiKeys?.keys.filter((key) => key.revoked).length ?? 0;
  const expiredGatewayKeys =
    apiKeys?.keys.filter((key) => !key.revoked && !!key.expiresAt && key.expiresAt <= now).length ?? 0;
  const registeredModels = modelCatalog?.length ?? totalModels;
  const thinkingModels = modelCatalog?.filter((model) => model.isThinking).length ?? 0;
  const customProviders = providers.filter((provider) => provider.isCustom).length;
  const builtInProviders = totalProviders - customProviders;
  const topModelProvider =
    providers.length > 0
      ? providers.reduce((top, provider) =>
          provider.modelCount > top.modelCount ? provider : top,
        )
      : null;
  const topAccountProvider =
    providers.length > 0
      ? providers.reduce((top, provider) =>
          provider.accountCount > top.accountCount ? provider : top,
        )
      : null;
  const providerModelItems = [...providers]
    .sort((left, right) => right.modelCount - left.modelCount)
    .slice(0, 5)
    .map((provider) => ({
      label: provider.displayName,
      value: provider.modelCount,
      secondary: `${formatCount(provider.accountCount)} acct`,
    }));
  const strategyLabel = config?.rotation?.strategy
    ? config.rotation.strategy
        .split('-')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ')
    : 'Round Robin';

  return (
    <div className="space-y-6">
      <OverviewHero
        strategy={strategyLabel}
        activeGatewayKeys={activeGatewayKeys}
        registeredModels={registeredModels}
        totalProviders={totalProviders}
        topModelProvider={topModelProvider}
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <StatTile
          label="Providers"
          value={formatCount(totalProviders)}
          hint={`${formatCount(builtInProviders)} built-in · ${formatCount(customProviders)} custom`}
          icon={<Boxes className="w-4 h-4" />}
        />
        <StatTile
          label="Provider accounts"
          value={formatCount(totalAccounts)}
          hint={
            topAccountProvider
              ? `${topAccountProvider.displayName} leads with ${formatCount(topAccountProvider.accountCount)}`
              : 'No accounts connected yet'
          }
          icon={<Users className="w-4 h-4" />}
        />
        <StatTile
          label="Gateway API keys"
          value={formatCount(activeGatewayKeys)}
          hint={`${formatCount(revokedGatewayKeys)} revoked · ${formatCount(expiredGatewayKeys)} expired`}
          badge={`${formatCount(gatewayKeyCount)} total`}
          icon={<KeyRound className="w-4 h-4" />}
        />
        <StatTile
          label="Callable models"
          value={formatCount(registeredModels)}
          hint={`${formatCount(thinkingModels)} thinking-ready models`}
          icon={<Cpu className="w-4 h-4" />}
        />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] gap-4">
        <QuickActionsPanel />

        <div className="card bg-base-200 border border-base-300 shadow-sm">
          <div className="card-body p-5 space-y-4">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-primary" />
              <div>
                <h2 className="text-sm font-bold tracking-wide text-base-content">
                  Provider Coverage
                </h2>
                <p className="text-xs text-base-content/50 mt-1">
                  Top providers ranked by available model coverage.
                </p>
              </div>
            </div>

            <BarList
              items={providerModelItems}
              format={(value) => formatCount(value)}
              emptyMessage="No provider inventory available yet"
            />
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3 flex-wrap px-1">
          <div>
            <h2 className="text-xs font-bold tracking-wider text-base-content/45 uppercase">
              Registered Providers
            </h2>
            <p className="text-xs text-base-content/45 mt-1">
              Cleaner status cards with share-of-capacity context.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {providers.map((provider) => (
            <ProviderCard
              key={provider.id}
              provider={provider}
              totalAccounts={totalAccounts}
              totalModels={totalModels}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
