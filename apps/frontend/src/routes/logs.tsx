import { createFileRoute } from '@tanstack/react-router';
import { LogViewer } from '../components/shared/LogViewer';

export const Route = createFileRoute('/logs')({
  component: LogsPage,
});

function LogsPage() {
  return (
    <div className="flex flex-col h-[calc(100vh-160px)] gap-4 text-base-content">
      <div>
        <h1 className="text-xl font-extrabold tracking-tight">System Telemetry Logs</h1>
        <p className="text-xs text-base-content/50 mt-0.5">Real-time captured streaming logs from the routing gateway.</p>
      </div>

      <div className="flex-1 min-h-0">
        <LogViewer maxHeight="h-full" showFilters={true} />
      </div>
    </div>
  );
}
