import { useQuery } from '@tanstack/react-query';
import { walletApi } from '../lib/api';

export function useBalance(enabled = true) {
  return useQuery({
    queryKey: ['wallet-balance'],
    queryFn: () => walletApi.balance().then((r) => r.data),
    refetchInterval: 15000,
    enabled,
    retry: false,
  });
}
