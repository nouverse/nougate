import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import {
  Provider,
  ProviderDetail,
  ProxyConfig,
  Account,
  ModelSpec,
  Lookback,
  TokenUsageResponse,
  RecentUsageLog,
  ApiKeysResponse,
  CustomProviderSummary,
  CustomProviderDetail,
  CatalogModel,
} from '@/lib/types';

export function useProviders() {
  return useQuery({
    queryKey: ['providers'],
    queryFn: () => api.get<Provider[]>('/api/providers'),
    staleTime: 30000,
  });
}

export function useProviderDetail(id: string) {
  return useQuery({
    queryKey: ['providers', id],
    queryFn: () => api.get<ProviderDetail>(`/api/providers/${id}`),
    enabled: !!id,
  });
}

export function useAccounts(id: string) {
  return useQuery({
    queryKey: ['providers', id, 'accounts'],
    queryFn: () => api.get<Account[]>(`/api/providers/${id}/accounts`),
    enabled: !!id,
  });
}

export function useModels(id: string) {
  return useQuery({
    queryKey: ['providers', id, 'models'],
    queryFn: () => api.get<ModelSpec[]>(`/api/providers/${id}/models`),
    enabled: !!id,
  });
}

/**
 * Every callable model across all providers, already prefixed.
 */
export function useModelCatalog() {
  return useQuery({
    queryKey: ['models', 'catalog'],
    queryFn: () => api.get<CatalogModel[]>('/api/models'),
    staleTime: 30000,
  });
}

export function useConfig() {
  const queryClient = useQueryClient();
  
  const query = useQuery({
    queryKey: ['config'],
    queryFn: () => api.get<ProxyConfig>('/api/config'),
  });

  const mutation = useMutation({
    mutationFn: (newConfig: ProxyConfig) => api.post<ProxyConfig>('/api/config', newConfig),
    onSuccess: (data) => {
      queryClient.setQueryData(['config'], data);
    },
  });

  return { ...query, updateConfig: mutation.mutate, isUpdating: mutation.isPending };
}

// ─── Token usage & cost ──────────────────────────────────────────────────────

export function useTokenUsage(lookback: Lookback, clientId: string, provider: string) {
  return useQuery({
    queryKey: ['metrics', 'token-usage', lookback, clientId, provider],
    queryFn: () =>
      api.get<TokenUsageResponse>(
        `/api/metrics/token-usage?lookback=${lookback}&clientId=${encodeURIComponent(clientId)}&provider=${encodeURIComponent(provider)}`,
      ),
    // Usage keeps accumulating while the page is open, so poll gently.
    refetchInterval: 30000,
  });
}

export function useRecentUsage(limit = 25) {
  return useQuery({
    queryKey: ['metrics', 'recent', limit],
    queryFn: () => api.get<RecentUsageLog[]>(`/api/metrics/recent?limit=${limit}`),
    refetchInterval: 30000,
  });
}

// ─── Gateway API keys ────────────────────────────────────────────────────────

export function useApiKeys() {
  return useQuery({
    queryKey: ['api-keys'],
    queryFn: () => api.get<ApiKeysResponse>('/api/api-keys'),
  });
}

// ─── Custom providers ────────────────────────────────────────────────────────

export function useCustomProviders() {
  return useQuery({
    queryKey: ['custom-providers'],
    queryFn: () => api.get<CustomProviderSummary[]>('/api/custom-providers'),
  });
}

export function useCustomProvider(id: string | null) {
  return useQuery({
    queryKey: ['custom-providers', id],
    queryFn: () => api.get<CustomProviderDetail>(`/api/custom-providers/${id}`),
    enabled: !!id,
  });
}

/**
 * Refresh everything a custom provider change can affect: its own detail, the
 * list, and the sidebar's provider registry view.
 */
export function useInvalidateCustomProviders() {
  const queryClient = useQueryClient();

  return () => {
    queryClient.invalidateQueries({ queryKey: ['custom-providers'] });
    queryClient.invalidateQueries({ queryKey: ['providers'] });
  };
}
