import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface PlatformStatus {
  status: string;
  /** True when the platform is in degrade mode: new builds paused, existing apps still serving. */
  killSwitch: boolean;
}

/**
 * Polls the public `/api/health` signal (proxied same-origin by nginx in prod)
 * so the UI can surface degrade mode. Slow poll — this only drives the
 * kill-switch banner, not anything interactive.
 */
export function usePlatformStatus() {
  return useQuery<PlatformStatus>({
    queryKey: ['platform-status'],
    queryFn: () => api<PlatformStatus>('/api/health'),
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: false,
  });
}
