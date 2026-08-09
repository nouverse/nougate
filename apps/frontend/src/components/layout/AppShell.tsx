import React, { useState, useEffect } from 'react';
import { Link, useRouterState } from '@tanstack/react-router';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { useProviders, useConfig } from '@/hooks/useQueries';
import { useTheme } from '@/hooks/useTheme';
import { useSSE } from '@/hooks/useSSE';
import { api } from '@/lib/api';
import { LogViewer } from '@/components/shared/LogViewer';
import { useAuth, logout } from '@/hooks/useAuth';
import { Menu, Settings, Terminal, Shield, List, Sun, Moon, LogOut, BarChart3, KeyRound, Boxes, FlaskConical, UsersRound, UserCog } from 'lucide-react';

interface Props {
  children: React.ReactNode;
}

export function AppShell({ children }: Props) {
  useSSE();

  const queryClient = useQueryClient();
  const { data: providers } = useProviders();
  const { data: config } = useConfig();
  const { data: auth } = useAuth();
  const { theme, toggleTheme } = useTheme();
  
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [consoleExpanded, setConsoleExpanded] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  const routerState = useRouterState();
  const pathname = routerState.location.pathname;

  useEffect(() => {
    const handleFlash = (e: Event) => {
      const data = (e as CustomEvent).detail;
      setToast({
        message: `${data.email}: Auth ${data.status.toUpperCase()}`,
        type: data.status,
      });
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

  const menuItems = [
    { label: 'Overview', to: '/' as any, icon: <List className="w-4 h-4" /> },
    { label: 'Token Metrics', to: '/tokens' as any, icon: <BarChart3 className="w-4 h-4" /> },
    { label: 'API Keys', to: '/api-keys' as any, icon: <KeyRound className="w-4 h-4" /> },
    { label: 'API Playground', to: '/playground' as any, icon: <FlaskConical className="w-4 h-4" /> },
    { label: 'Custom Providers', to: '/custom-providers' as any, icon: <Boxes className="w-4 h-4" /> },
    { label: 'Users', to: '/users' as any, icon: <UsersRound className="w-4 h-4" /> },
    { label: 'Account Settings', to: '/settings' as any, icon: <UserCog className="w-4 h-4" /> },
    { label: 'Global Config', to: '/config' as any, icon: <Settings className="w-4 h-4" /> },
    { label: 'System Logs', to: '/logs' as any, icon: <Terminal className="w-4 h-4 text-primary" /> },
  ];

  const getBreadcrumbs = () => {
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length === 0) return ['Overview'];
    
    return parts.map((part) => {
      if (part === 'providers') return 'Providers';
      if (part === 'antigravity') return 'Google Antigravity';
      return part.charAt(0).toUpperCase() + part.slice(1);
    });
  };

  const currentBreadcrumbs = getBreadcrumbs();

  const handleNavClick = () => {
    setDrawerOpen(false);
  };

  const navSidebarContent = (
    <div className="flex flex-col h-full bg-base-200 border-r border-base-300">
      <div className="flex items-center gap-3 px-6 py-5 border-b border-base-300">
        <div className="bg-primary text-primary-content p-1.5 rounded-lg">
          <Shield className="w-5 h-5" />
        </div>
        <div>
          <span className="font-extrabold text-base-content text-lg tracking-wider">NOUGATE</span>
          <span className="block text-[10px] text-base-content/40 font-mono tracking-widest mt-0.5">NOUVERSE AI GATEWAY</span>
        </div>
      </div>

      <div className="flex-1 px-4 py-6 space-y-7 overflow-y-auto">
        <div className="space-y-1">
          <span className="px-3 text-[10px] font-bold text-base-content/40 tracking-wider uppercase block mb-2">Navigation</span>
          {menuItems.map((item) => (
            <Link
              key={item.label}
              to={item.to}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-xs font-semibold transition-all duration-200 ${
                pathname === item.to
                  ? 'bg-primary text-primary-content shadow-md shadow-primary/20 scale-[1.02]'
                  : 'text-base-content/75 hover:bg-base-300 hover:text-base-content'
              }`}
              onClick={handleNavClick}
            >
              {item.icon}
              {item.label}
            </Link>
          ))}
        </div>

        <div className="space-y-1">
          <span className="px-3 text-[10px] font-bold text-base-content/40 tracking-wider uppercase block mb-2">Active Providers</span>
          {providers && providers.map((prov) => (
            <Link
              key={prov.id}
              to={`/providers/${prov.id}` as any}
              className={`flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-semibold transition-all duration-200 ${
                pathname.startsWith(`/providers/${prov.id}`)
                  ? 'bg-secondary text-secondary-content shadow-md shadow-secondary/20 scale-[1.02]'
                  : 'text-base-content/75 hover:bg-base-300 hover:text-base-content'
              }`}
              onClick={handleNavClick}
            >
              <div className="flex items-center gap-3 min-w-0">
                <span className="w-2 h-2 rounded-full bg-success shrink-0" />
                <div className="min-w-0 leading-tight">
                  <span className="capitalize block truncate">{prov.displayName}</span>
                  {/* The prefix is what users actually type into a client. */}
                  <span className="block font-mono text-[10px] opacity-60 truncate">
                    {prov.id}:
                  </span>
                </div>
              </div>
              <span className="badge badge-xs badge-neutral border-0 bg-base-300 text-base-content/60 font-mono font-bold px-1.5 py-1 shrink-0">
                {prov.accountCount}
              </span>
            </Link>
          ))}
        </div>
      </div>

      <div className="p-4 border-t border-base-300 text-[10px] text-base-content/40 text-center font-mono">
        v0.7.0 • Local Environment
      </div>
    </div>
  );

  return (
    <div className="flex h-screen overflow-hidden bg-base-100 font-sans">
      <aside className="hidden lg:block w-64 shrink-0 h-full">
        {navSidebarContent}
      </aside>

      {drawerOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setDrawerOpen(false)} />
          <nav className="fixed top-0 bottom-0 left-0 w-64 max-w-[80vw]">
            {navSidebarContent}
          </nav>
        </div>
      )}

      <div className="flex-1 flex flex-col min-w-0 h-full relative">
        <header className="navbar bg-base-100 border-b border-base-300 px-4 h-16 shrink-0 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button
              className="btn btn-ghost btn-sm lg:hidden px-1"
              onClick={() => setDrawerOpen(!drawerOpen)}
            >
              <Menu className="w-5 h-5 text-base-content" />
            </button>
            
            <div className="breadcrumbs text-xs font-semibold select-none hidden sm:block text-base-content">
              <ul>
                <li>NOUGATE</li>
                {currentBreadcrumbs.map((crumb, idx) => (
                  <li key={idx} className="capitalize text-base-content/60">
                    {crumb}
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold text-base-content/50 uppercase tracking-wider hidden md:block">
                STRATEGY:
              </span>
              <select
                className="select select-bordered select-xs max-w-xs font-semibold bg-base-200 text-xs focus:outline-none text-base-content"
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
            </div>

            <button
              onClick={toggleTheme}
              className="btn btn-ghost btn-xs px-2 text-base-content"
              title="Toggle Light/Dark Theme"
            >
              {theme === 'nougate' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>

            {auth?.user && (
              <div className="flex items-center gap-2 pl-3 border-l border-base-300">
                <Link
                  to={'/settings' as any}
                  className="text-[10px] font-mono text-base-content/50 hover:text-base-content hidden md:block max-w-[14rem] truncate"
                  title={`${auth.user.username} — account settings`}
                >
                  {auth.user.username}
                </Link>
                <button
                  onClick={logout}
                  className="btn btn-ghost btn-xs px-2 text-base-content"
                  title="Sign out"
                >
                  <LogOut className="w-4 h-4" />
                </button>
              </div>
            )}
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-4 lg:p-6 space-y-6 pb-20">
          <div className="pb-14">
            {children}
          </div>
        </main>

        <div className={`absolute bottom-0 left-0 right-0 z-20 border-t border-base-300 bg-neutral shadow-2xl transition-all duration-300 ${
          consoleExpanded ? 'h-72' : 'h-10'
        }`}>
          <div
            className="flex items-center justify-between px-4 py-2 bg-base-300/80 cursor-pointer select-none border-b border-base-300"
            onClick={() => setConsoleExpanded(!consoleExpanded)}
          >
            <div className="flex items-center gap-2">
              <Terminal className="w-3.5 h-3.5 text-primary" />
              <span className="text-[10px] font-bold tracking-wider text-base-content uppercase">
                System Console Logs
              </span>
            </div>
            <span className="text-[10px] text-base-content/50 font-bold font-mono">
              {consoleExpanded ? 'Collapse ▲' : 'Expand ▼'}
            </span>
          </div>

          {consoleExpanded && (
            <div className="h-[248px]">
              <LogViewer maxHeight="h-[200px]" showFilters={true} />
            </div>
          )}
        </div>

        {toast && (
          <div className="toast toast-end toast-bottom z-50 p-4">
            <div className={`alert ${toast.type === 'error' ? 'alert-error' : 'alert-success'} text-xs font-semibold shadow-lg`}>
              <span>{toast.message}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
