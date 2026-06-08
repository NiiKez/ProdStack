import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface CurrentUser {
  id: string;
  githubLogin: string;
  email: string | null;
  avatarUrl: string | null;
  isDemo: boolean;
}

export function useCurrentUser() {
  return useQuery<CurrentUser>({
    queryKey: ['me'],
    queryFn: () => api<CurrentUser>('/api/auth/me'),
    retry: false,
    staleTime: 60_000,
  });
}
