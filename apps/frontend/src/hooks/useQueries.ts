import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Provider, ProviderDetail, ProxyConfig, Account, ModelSpec } from '@/lib/types';

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
