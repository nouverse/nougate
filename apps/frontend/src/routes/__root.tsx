import { createRootRoute, Outlet, Link } from '@tanstack/react-router';
import { AppShell } from '@/components/layout/AppShell';
import { Compass } from 'lucide-react';

/**
 * Shown for a path the router does not recognise.
 *
 * The backend serves index.html for every /frontend/* path, so a URL that no
 * route matches lands here rather than producing an HTTP 404 — most often
 * because the bundle being served predates the route.
 */
function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center py-20 gap-3 text-center text-base-content">
      <Compass className="w-8 h-8 text-base-content/20" />
      <h1 className="text-lg font-extrabold tracking-tight">Page not found</h1>
      <p className="text-xs text-base-content/50 max-w-sm leading-relaxed">
        Nothing is routed at{' '}
        <code className="font-mono">{window.location.pathname}</code>. If you expected a page
        that was added recently, rebuild the dashboard bundle
        (<code className="font-mono">bun run build:frontend</code>) and hard-refresh.
      </p>
      <Link to="/" className="btn btn-sm btn-primary rounded-xl font-semibold mt-2">
        Back to overview
      </Link>
    </div>
  );
}

export const Route = createRootRoute({
  component: () => (
    <AppShell>
      <Outlet />
    </AppShell>
  ),
  notFoundComponent: NotFound,
});
