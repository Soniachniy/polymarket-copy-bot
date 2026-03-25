import { useQuery } from '@tanstack/react-query';
import { botApi } from '../lib/api';

export function useBotStatus() {
  return useQuery({
    queryKey: ['bot-status'],
    queryFn: () => botApi.status().then((r) => r.data),
    refetchInterval: 2000,
    retry: false,
  });
}
