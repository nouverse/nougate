import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useProviders } from '@/hooks/useQueries';
import { useEffect } from 'react';

export const Route = createFileRoute('/providers/')({
  component: ProvidersPageIndex,
});

function ProvidersPageIndex() {
  const { data: providers, isLoading } = useProviders();
  const navigate = useNavigate();

  useEffect(() => {
    if (providers && providers.length > 0) {
      navigate({ to: `/providers/${providers[0].id}`, replace: true });
    }
  }, [providers, navigate]);

  return (
    <div className="flex flex-col items-center justify-center py-12 gap-3 text-base-content/60">
      <span className="loading loading-spinner loading-md" />
      <span className="text-sm font-medium">Redirecting to provider...</span>
    </div>
  );
}
