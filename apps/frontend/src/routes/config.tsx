import { createFileRoute } from '@tanstack/react-router';
import { useConfig } from '@/hooks/useQueries';
import { JsonEditor } from '@/components/shared/JsonEditor';
import { useState } from 'react';
import { Settings, Code, ShieldCheck, Zap } from 'lucide-react';

export const Route = createFileRoute('/config')({
  component: ConfigPage,
});

function ConfigPage() {
  const { data: config, updateConfig, isUpdating, isLoading, error } = useConfig();
  const [activeTab, setActiveTab] = useState<'form' | 'json'>('form');
  const [toast, setToast] = useState<string | null>(null);

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-3 text-base-content/60">
        <span className="loading loading-spinner loading-md" />
        <span className="text-sm font-medium">Loading configuration...</span>
      </div>
    );
  }

  if (error || !config) {
    return (
      <div className="alert alert-error text-xs font-semibold shadow-md">
        <span>Failed to load configuration: {error?.message || 'Unknown error'}</span>
      </div>
    );
  }

  const handleFormSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);

    const updated = {
      ...config,
      rotation: {
        ...config.rotation,
        strategy: formData.get('rotation.strategy') as string,
        decayRate: parseFloat(formData.get('rotation.decayRate') as string) || 0.1,
      },
      scoring: {
        ...config.scoring,
        weightSuccess: parseFloat(formData.get('scoring.weightSuccess') as string) ?? 0.5,
        weightLatency: parseFloat(formData.get('scoring.weightLatency') as string) ?? 0.3,
        weightHealth: parseFloat(formData.get('scoring.weightHealth') as string) ?? 0.2,
      },
      retry: {
        ...config.retry,
        maxAttempts: parseInt(formData.get('retry.maxAttempts') as string, 10) || 3,
        backoffBaseMs: parseInt(formData.get('retry.backoffBaseMs') as string, 10) || 500,
      },
      logging: {
        ...config.logging,
        level: formData.get('logging.level') as string,
      },
      headroom: {
        ...config.headroom,
        enabled: formData.get('headroom.enabled') === 'on',
        url: (formData.get('headroom.url') as string) || undefined,
        timeoutMs: parseInt(formData.get('headroom.timeoutMs') as string, 10) || 5000,
      },
      rtk: {
        ...config.rtk,
        enabled: formData.get('rtk.enabled') === 'on',
      },
      caveman: {
        ...config.caveman,
        enabled: formData.get('caveman.enabled') === 'on',
        level: parseInt(formData.get('caveman.level') as string, 10) || 3,
      }
    };

    updateConfig(updated, {
      onSuccess: () => {
        setToast('Configuration updated successfully!');
        setTimeout(() => setToast(null), 3000);
      }
    });
  };

  const handleJsonSave = (newVal: Record<string, any>) => {
    updateConfig(newVal as any, {
      onSuccess: () => {
        setToast('JSON Configuration updated successfully!');
        setTimeout(() => setToast(null), 3000);
      }
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-base-300 pb-4 text-base-content">
        <div>
          <h1 className="text-xl font-extrabold tracking-tight">Global Configurations</h1>
          <p className="text-xs text-base-content/50 mt-0.5">Manage gateway strategy, routing metrics, and upstream parameters.</p>
        </div>

        <div className="tabs tabs-box bg-base-200 p-0.5 rounded-lg self-start">
          <button
            type="button"
            className={`tab tab-xs rounded-md ${activeTab === 'form' ? 'tab-active font-semibold' : 'text-base-content/60'}`}
            onClick={() => setActiveTab('form')}
          >
            <Settings className="w-3.5 h-3.5 mr-1" />
            Forms Editor
          </button>
          <button
            type="button"
            className={`tab tab-xs rounded-md ${activeTab === 'json' ? 'tab-active font-semibold' : 'text-base-content/60'}`}
            onClick={() => setActiveTab('json')}
          >
            <Code className="w-3.5 h-3.5 mr-1" />
            Raw JSON
          </button>
        </div>
      </div>

      {activeTab === 'form' ? (
        <form onSubmit={handleFormSubmit} className="space-y-6 text-base-content pb-24">
          <div className="card bg-base-200 border border-base-300 shadow-sm">
            <div className="card-body p-5 space-y-4">
              <h3 className="card-title text-sm font-bold tracking-wide flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-primary" />
                ROTATION & QUOTA SCHEDULING
              </h3>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="form-control w-full">
                  <label className="label">
                    <span className="label-text font-semibold text-xs text-base-content/75">Selection Strategy</span>
                  </label>
                  <select
                    name="rotation.strategy"
                    className="select select-bordered select-sm w-full bg-base-100 text-xs focus:outline-none"
                    defaultValue={config.rotation?.strategy || 'round-robin'}
                  >
                    <option value="round-robin">Round Robin Selection</option>
                    <option value="sticky">Sticky Session Routing</option>
                    <option value="least-used">Least Used Pool</option>
                    <option value="random">Random Load Balancer</option>
                    <option value="hybrid">Hybrid Intelligent</option>
                  </select>
                </div>

                <div className="form-control w-full">
                  <label className="label">
                    <span className="label-text font-semibold text-xs text-base-content/75">Cooldown Decay Rate</span>
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    name="rotation.decayRate"
                    className="input input-bordered input-sm w-full bg-base-100 font-mono text-xs"
                    defaultValue={config.rotation?.decayRate ?? 0.1}
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="card bg-base-200 border border-base-300 shadow-sm">
            <div className="card-body p-5 space-y-4">
              <h3 className="card-title text-sm font-bold tracking-wide">
                SCORING ALGORITHM WEIGHTS
              </h3>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="form-control w-full">
                  <label className="label">
                    <span className="label-text font-semibold text-xs text-base-content/75">Success Rate Weight</span>
                  </label>
                  <input
                    type="number"
                    step="0.05"
                    name="scoring.weightSuccess"
                    className="input input-bordered input-sm w-full bg-base-100 font-mono text-xs"
                    defaultValue={config.scoring?.weightSuccess ?? 0.5}
                  />
                </div>

                <div className="form-control w-full">
                  <label className="label">
                    <span className="label-text font-semibold text-xs text-base-content/75">Latency Score Weight</span>
                  </label>
                  <input
                    type="number"
                    step="0.05"
                    name="scoring.weightLatency"
                    className="input input-bordered input-sm w-full bg-base-100 font-mono text-xs"
                    defaultValue={config.scoring?.weightLatency ?? 0.3}
                  />
                </div>

                <div className="form-control w-full">
                  <label className="label">
                    <span className="label-text font-semibold text-xs text-base-content/75">Health Score Weight</span>
                  </label>
                  <input
                    type="number"
                    step="0.05"
                    name="scoring.weightHealth"
                    className="input input-bordered input-sm w-full bg-base-100 font-mono text-xs"
                    defaultValue={config.scoring?.weightHealth ?? 0.2}
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="card bg-base-200 border border-base-300 shadow-sm">
            <div className="card-body p-5 space-y-4">
              <h3 className="card-title text-sm font-bold tracking-wide">
                RETRIES & LOGS PARAMETERS
              </h3>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="form-control w-full">
                  <label className="label">
                    <span className="label-text font-semibold text-xs text-base-content/75">Max Retry Attempts</span>
                  </label>
                  <input
                    type="number"
                    name="retry.maxAttempts"
                    className="input input-bordered input-sm w-full bg-base-100 font-mono text-xs"
                    defaultValue={config.retry?.maxAttempts ?? 3}
                  />
                </div>

                <div className="form-control w-full">
                  <label className="label">
                    <span className="label-text font-semibold text-xs text-base-content/75">Backoff Base Delay (ms)</span>
                  </label>
                  <input
                    type="number"
                    name="retry.backoffBaseMs"
                    className="input input-bordered input-sm w-full bg-base-100 font-mono text-xs"
                    defaultValue={config.retry?.backoffBaseMs ?? 500}
                  />
                </div>

                <div className="form-control w-full">
                  <label className="label">
                    <span className="label-text font-semibold text-xs text-base-content/75">System Logging Level</span>
                  </label>
                  <select
                    name="logging.level"
                    className="select select-bordered select-sm w-full bg-base-100 text-xs focus:outline-none"
                    defaultValue={config.logging?.level || 'info'}
                  >
                    <option value="debug">Debug (All events)</option>
                    <option value="info">Info (Default events)</option>
                    <option value="warn">Warn (Only failures)</option>
                  </select>
                </div>
              </div>
            </div>
          </div>

          <div className="card bg-base-200 border border-base-300 shadow-sm">
            <div className="card-body p-5 space-y-4">
              <h3 className="card-title text-sm font-bold tracking-wide flex items-center gap-2">
                <Zap className="w-4 h-4 text-warning" />
                TOKEN COMPRESSION
              </h3>
              <p className="text-xs text-base-content/60 -mt-2">
                Reduce token usage with RTK (tool result compression), Headroom (semantic compression), and Caveman (terse output).
              </p>

              {/* RTK */}
              <div className="border border-base-300 rounded-lg p-3 space-y-3">
                <div className="flex items-center gap-2">
                  <span className="badge badge-sm badge-success font-bold">RTK</span>
                  <span className="text-xs text-base-content/70">Tool Result Compression — lossless, inline, zero overhead</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div className="form-control w-full">
                    <label className="label cursor-pointer justify-start gap-3">
                      <input
                        type="checkbox"
                        name="rtk.enabled"
                        className="toggle toggle-sm toggle-success"
                        defaultChecked={config.rtk?.enabled ?? true}
                      />
                      <span className="label-text font-semibold text-xs text-base-content/75">Enable RTK</span>
                    </label>
                  </div>
                </div>
              </div>

              {/* Headroom */}
              <div className="border border-base-300 rounded-lg p-3 space-y-3">
                <div className="flex items-center gap-2">
                  <span className="badge badge-sm badge-primary font-bold">Headroom</span>
                  <span className="text-xs text-base-content/70">Semantic compression via external service</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div className="form-control w-full">
                    <label className="label cursor-pointer justify-start gap-3">
                      <input
                        type="checkbox"
                        name="headroom.enabled"
                        className="toggle toggle-sm toggle-primary"
                        defaultChecked={config.headroom?.enabled ?? false}
                      />
                      <span className="label-text font-semibold text-xs text-base-content/75">Enable Headroom</span>
                    </label>
                  </div>

                  <div className="form-control w-full">
                    <label className="label">
                      <span className="label-text font-semibold text-xs text-base-content/75">Service URL</span>
                    </label>
                    <input
                      type="text"
                      name="headroom.url"
                      placeholder="http://headroom:8787"
                      className="input input-bordered input-sm w-full bg-base-100 font-mono text-xs"
                      defaultValue={config.headroom?.url || ''}
                    />
                    <label className="label">
                      <span className="label-text-alt text-[10px] text-base-content/50">Auto-detected from HEADROOM_URL env</span>
                    </label>
                  </div>

                  <div className="form-control w-full">
                    <label className="label">
                      <span className="label-text font-semibold text-xs text-base-content/75">Base Timeout (ms)</span>
                    </label>
                    <input
                      type="number"
                      name="headroom.timeoutMs"
                      className="input input-bordered input-sm w-full bg-base-100 font-mono text-xs"
                      defaultValue={config.headroom?.timeoutMs ?? 5000}
                    />
                    <label className="label">
                      <span className="label-text-alt text-[10px] text-base-content/50">Adaptive: scales up with message count</span>
                    </label>
                  </div>
                </div>
              </div>

              {/* Caveman */}
              <div className="border border-base-300 rounded-lg p-3 space-y-3">
                <div className="flex items-center gap-2">
                  <span className="badge badge-sm badge-warning font-bold">Caveman</span>
                  <span className="text-xs text-base-content/70">Terse output mode — reduce output tokens</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div className="form-control w-full">
                    <label className="label cursor-pointer justify-start gap-3">
                      <input
                        type="checkbox"
                        name="caveman.enabled"
                        className="toggle toggle-sm toggle-warning"
                        defaultChecked={config.caveman?.enabled ?? false}
                      />
                      <span className="label-text font-semibold text-xs text-base-content/75">Enable Caveman</span>
                    </label>
                  </div>

                  <div className="form-control w-full">
                    <label className="label">
                      <span className="label-text font-semibold text-xs text-base-content/75">Intensity Level (1-5)</span>
                    </label>
                    <select
                      name="caveman.level"
                      className="select select-bordered select-sm w-full bg-base-100 text-xs"
                      defaultValue={config.caveman?.level ?? 3}
                    >
                      <option value="1">1 — Mild (concise) ✅ safe for tool calls</option>
                      <option value="2">2 — Moderate (short sentences) ✅ safe for tool calls</option>
                      <option value="3">3 — Strong (telegraphic) ⚠️ may affect planning</option>
                      <option value="4">4 — Extreme (bullet points) ❌ risky for agents</option>
                      <option value="5">5 — Maximum (raw output) ❌ not for agentic use</option>
                    </select>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <button
              type="submit"
              className="btn btn-sm btn-primary rounded-xl font-semibold"
              disabled={isUpdating}
            >
              {isUpdating ? <span className="loading loading-spinner loading-xs" /> : 'Save Configurations'}
            </button>
          </div>
        </form>
      ) : (
        <div className="card bg-base-200 border border-base-300 shadow-sm p-5 text-base-content">
          <JsonEditor value={config} onSave={handleJsonSave} isSaving={isUpdating} />
        </div>
      )}

      {toast && (
        <div className="toast toast-end toast-bottom z-50 p-4">
          <div className="alert alert-success text-xs font-semibold shadow-lg">
            <span>{toast}</span>
          </div>
        </div>
      )}
    </div>
  );
}
