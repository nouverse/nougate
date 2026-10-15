import React, { useEffect, useState } from 'react';
import { Link, useRouterState } from '@tanstack/react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BarChart3, Boxes, FlaskConical, KeyRound, List, Plug, Settings, Terminal } from 'lucide-react';
import { useConfig, useProviders } from '@/hooks/useQueries';
import { useSSE } from '@/hooks/useSSE';
import { useHostTheme } from '@/hooks/useTheme';
import { api } from '@/lib/api';

/**
 * The dashboard as a page of a host's dashboard (`lib/host.ts`) — Nouride's "LLM Gateway".
 *
 * The host draws the outer frame: its sidebar, its sign-in, its account menu, its theme switch. So
 * this draws none of them, and the gateway's own sections become a row of tabs rather than a second
 * sidebar beside the host's — two sidebars side by side leave the page itself a strip in the middle.
 *
 * Users and Account Settings are left out on purpose. Inside a host the person is the host's
 * account, not one of this gateway's, and a page offering to change "your" password here would be
 * changing an account they never signed in with.
 */

const SECTIONS = [
  { label: 'Overview', to: '/', icon: List, match: (path: string) => path === '/' },
  { label: 'Accounts', to: '/providers', icon: Plug, match: (path: string) => path.startsWith('/providers') },
  { label: 'Usage', to: '/tokens', icon: BarChart3, match: (path: string) => path.startsWith('/tokens') },
  { label: 'API Keys', to: '/api-keys', icon: KeyRound, match: (path: string) => path.startsWith('/api-keys') },
  { label: 'Playground', to: '/playground', icon: FlaskConical, match: (path: string) => path.startsWith('/playground') },
  { label: 'Custom Providers', to: '/custom-providers', icon: Boxes, match: (path: string) => path.startsWith('/custom-providers') },
  { label: 'Settings', to: '/config', icon: Settings, match: (path: string) => path.startsWith('/config') },
  { label: 'Logs', to: '/logs', icon: Terminal, match: (path: string) => path.startsWith('/logs') },
] as const;

export function EmbeddedShell({ children }: { children: React.ReactNode }) {
  useSSE();
  useHostTheme();

  const queryClient = useQueryClient();
  const { data: providers } = useProviders();
  const { data: config } = useConfig();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  /**
   * Tell the host where this page is, so its address bar can follow.
   *
   * Addressed to this origin rather than `'*'`: the host is same-origin by construction (it serves
   * this page from its own routes), and a path is nothing to broadcast to whatever framed it.
   */
  useEffect(() => {
    if (window.parent === window) return;
    window.parent.postMessage({ type: 'nougate:navigate', path: pathname }, window.location.origin);
  }, [pathname]);

  useEffect(() => {
    const handleFlash = (e: Event) => {
      const data = (e as CustomEvent).detail;
      setToast({ message: `${data.email}: Auth ${data.status.toUpperCase()}`, type: data.status });
      setTimeout(() => setToast(null), 5000);
    };
    window.addEventListener('nougate:flash', handleFlash);
    return () => window.removeEventListener('nougate:flash', handleFlash);
  }, []);

  const strategyMutation = useMutation({
    mutationFn: (strategy: string) => api.post('/api/strategy', { strategy }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['config'] });
      setToast({ message: 'Rotation strategy updated!', type: 'success' });
      setTimeout(() => setToast(null), 3000);
    },
    onError: (err: any) => {
      setToast({ message: err.message || 'Failed to update strategy', type: 'error' });
      setTimeout(() => setToast(null), 4000);
    },
  });

  const activeStrategy = config?.rotation?.strategy || 'round-robin';
  const onProviders = pathname.startsWith('/providers');

  return (
    <div className="min-h-screen bg-base-100 font-sans text-base-content">
      <header className="sticky top-0 z-30 border-b border-base-300 bg-base-100/95 backdrop-blur px-3 sm:px-4 pt-3 pb-2 space-y-2">
        <div className="flex items-center gap-3">
          <nav className="flex-1 min-w-0 flex gap-1 overflow-x-auto pb-1" aria-label="LLM Gateway sections">
            {SECTIONS.map(({ label, to, icon: Icon, match }) => (
              <Link
                key={to}
                to={to as any}
                className={`shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${
                  match(pathname)
                    ? 'bg-primary text-primary-content shadow-sm'
                    : 'text-base-content/70 hover:bg-base-200 hover:text-base-content'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {label}
              </Link>
            ))}
          </nav>

          <label className="hidden sm:flex items-center gap-2 shrink-0">
            <span className="text-[10px] font-bold text-base-content/50 uppercase tracking-wider hidden md:block">
              Strategy
            </span>
            <select
              className="select select-bordered select-xs font-semibold bg-base-200 text-xs focus:outline-none"
              value={activeStrategy}
              onChange={(e) => strategyMutation.mutate(e.target.value)}
              disabled={strategyMutation.isPending}
            >
              <option value="round-robin">Round Robin</option>
              <option value="sticky">Sticky Routing</option>
              <option value="least-used">Least Used</option>
              <option value="random">Random Selection</option>
              <option value="hybrid">Hybrid Intelligent</option>
            </select>
          </label>
        </div>

        {/* Which provider's accounts — the second half of what the standalone sidebar shows. */}
        {onProviders && providers && providers.length > 0 && (
          <nav className="flex gap-1.5 overflow-x-auto pb-1" aria-label="Providers">
            {providers.map((prov) => {
              const active = pathname.startsWith(`/providers/${prov.id}`);
              const full = prov.accountLimit !== null && prov.accountCount >= prov.accountLimit;
              return (
                <Link
                  key={prov.id}
                  to={`/providers/${prov.id}` as any}
                  className={`shrink-0 inline-flex items-center gap-2 px-3 py-1 rounded-lg text-xs font-semibold border transition-colors ${
                    active
                      ? 'border-secondary bg-secondary text-secondary-content'
                      : 'border-base-300 text-base-content/75 hover:bg-base-200'
                  }`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${prov.accountCount > 0 ? 'bg-success' : 'bg-base-content/25'}`} />
                  {prov.displayName}
                  <span className={`font-mono text-[10px] ${full ? 'text-warning' : 'opacity-60'}`}>
                    {prov.accountLimit === null ? prov.accountCount : `${prov.accountCount}/${prov.accountLimit}`}
                  </span>
                </Link>
              );
            })}
          </nav>
        )}
      </header>

      <main className="p-3 sm:p-4 lg:p-6 space-y-6">{children}</main>

      {toast && (
        <div className="toast toast-end toast-bottom z-50 p-4">
          <div className={`alert ${toast.type === 'error' ? 'alert-error' : 'alert-success'} text-xs font-semibold shadow-lg`}>
            <span>{toast.message}</span>
          </div>
        </div>
      )}
    </div>
  );
}
