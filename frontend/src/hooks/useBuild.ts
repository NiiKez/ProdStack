import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { isInFlight } from '@/lib/status';
import type { BuildDetail } from '@/types/api';

/**
 * Build detail. Polls while the build is in-flight so the header status pill
 * and duration stay fresh even if the SSE stream hiccups; stops polling once
 * the build reaches a terminal state. The live log stream
 * (`useBuildLogs`) is the primary real-time surface — this is the durable
 * fallback + source of commit/duration metadata.
 */
export function useBuild(buildId: string | undefined) {
  return useQuery<BuildDetail>({
    queryKey: ['build', buildId],
    queryFn: () => api<BuildDetail>(`/api/builds/${buildId}`),
    enabled: Boolean(buildId),
    refetchInterval: (query) => (isInFlight(query.state.data?.status) ? 4_000 : false),
  });
}
