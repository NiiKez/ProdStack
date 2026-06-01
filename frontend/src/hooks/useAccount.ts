import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { AccountInfo } from '@/types/api';

/** `GET /api/account` — the signed-in user's profile, GitHub/Azure status, and counts. */
export function useAccount() {
  return useQuery<AccountInfo>({
    queryKey: ['account'],
    queryFn: () => api<AccountInfo>('/api/account'),
    staleTime: 30_000,
  });
}
