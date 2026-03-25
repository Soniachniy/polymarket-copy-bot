import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { configApi } from '../lib/api';
import type { AppConfig } from '../lib/api';

export function useConfig() {
  return useQuery({
    queryKey: ['config'],
    queryFn: () => configApi.get().then((r) => r.data),
    retry: false,
  });
}

export function useUpdateConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<AppConfig>) => configApi.update(data).then((r) => r.data),
    onSuccess: (updated) => {
      qc.setQueryData(['config'], updated);
    },
  });
}
