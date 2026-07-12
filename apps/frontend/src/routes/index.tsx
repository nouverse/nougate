import { createFileRoute, Link } from '@tanstack/react-router';
import { useProviders } from '@/hooks/useQueries';
import { Shield, Key, Cpu, ArrowRight, Server } from 'lucide-react';

export const Route = createFileRoute('/')({
  component: OverviewPage,
});

function OverviewPage() {
  const { data: providers, isLoading, error } = useProviders();

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

  const totalProviders = providers.length;
  const totalAccounts = providers.reduce((acc, curr) => acc + curr.accountCount, 0);
  const totalModels = providers.reduce((acc, curr) => acc + curr.modelCount, 0);

  return (
    <div className="space-y-6">
      <div className="hero bg-base-200 border border-base-300 rounded-3xl p-6 lg:p-8 select-none">
        <div className="hero-content flex-col lg:flex-row gap-6 p-0 max-w-none text-left justify-start">
          <div className="bg-primary/10 border border-primary/20 p-4 rounded-2xl text-primary shrink-0">
            <Shield className="w-12 h-12" />
          </div>
          <div>
            <h1 className="text-xl lg:text-2xl font-extrabold text-base-content tracking-tight leading-none">
              Welcome to Nougate LLM Gateway
            </h1>
            <p className="py-2 text-sm text-base-content/65 max-w-2xl leading-relaxed">
              Nougate is a modular multi-provider router that provides account isolation, intelligent request scheduling, automatic cooldowned rotation, and real-time telemetry.
            </p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="card bg-base-200 border border-base-300 shadow-sm p-4 flex flex-row items-center gap-4 select-none">
          <div className="bg-info/10 text-info p-2.5 rounded-xl border border-info/20">
            <Server className="w-6 h-6" />
          </div>
          <div>
            <span className="block text-[10px] font-bold text-base-content/40 tracking-wider uppercase">Active Providers</span>
            <span className="text-2xl font-black text-base-content font-mono leading-none mt-1 block">
              {totalProviders}
            </span>
          </div>
        </div>

        <div className="card bg-base-200 border border-base-300 shadow-sm p-4 flex flex-row items-center gap-4 select-none">
          <div className="bg-success/10 text-success p-2.5 rounded-xl border border-success/20">
            <Key className="w-6 h-6" />
          </div>
          <div>
            <span className="block text-[10px] font-bold text-base-content/40 tracking-wider uppercase">Total Accounts</span>
            <span className="text-2xl font-black text-base-content font-mono leading-none mt-1 block">
              {totalAccounts}
            </span>
          </div>
        </div>

        <div className="card bg-base-200 border border-base-300 shadow-sm p-4 flex flex-row items-center gap-4 select-none">
          <div className="bg-secondary/10 text-secondary p-2.5 rounded-xl border border-secondary/20">
            <Cpu className="w-6 h-6" />
          </div>
          <div>
            <span className="block text-[10px] font-bold text-base-content/40 tracking-wider uppercase">Supported Models</span>
            <span className="text-2xl font-black text-base-content font-mono leading-none mt-1 block">
              {totalModels}
            </span>
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <h2 className="text-xs font-bold tracking-wider text-base-content/45 uppercase px-1">
          REGISTERED PROVIDERS
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {providers.map((prov) => (
            <div
              key={prov.id}
              className="card bg-base-200 border border-base-300 shadow-sm hover:shadow-md hover:border-primary/20 transition-all duration-300"
            >
              <div className="card-body p-5 space-y-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="font-bold text-base text-base-content capitalize">{prov.displayName}</h3>
                    <span className="text-[10px] font-mono text-base-content/40 block mt-0.5">ID: {prov.id}</span>
                  </div>
                  <span className="badge badge-success badge-sm font-semibold tracking-wide">
                    Online
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-4 bg-base-300/40 p-3 rounded-xl text-center select-none">
                  <div>
                    <span className="text-[10px] text-base-content/40 font-bold block">ACCOUNTS</span>
                    <span className="text-lg font-extrabold text-base-content font-mono mt-0.5 block">{prov.accountCount}</span>
                  </div>
                  <div>
                    <span className="text-[10px] text-base-content/40 font-bold block">MODELS</span>
                    <span className="text-lg font-extrabold text-base-content font-mono mt-0.5 block">{prov.modelCount}</span>
                  </div>
                </div>

                <div className="card-actions justify-end">
                  <Link
                    to="/providers/$providerId"
                    params={{ providerId: prov.id }}
                    className="btn btn-primary btn-sm rounded-xl font-semibold gap-1.5"
                  >
                    Manage
                    <ArrowRight className="w-4 h-4" />
                  </Link>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
