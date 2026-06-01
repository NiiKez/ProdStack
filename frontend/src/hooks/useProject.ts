import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { isInFlight } from '@/lib/status';
import type { ProjectDetail } from '@/types/api';

export function useProject(id: string | undefined) {
  return useQuery<ProjectDetail>({
    queryKey: ['project', id],
    queryFn: () => api<ProjectDetail>(`/api/projects/${id}`),
    enabled: Boolean(id),
    // Poll while the latest build is in-flight so the header status pill +
    // builds list advance through stages live (SSE drives the dedicated logs
    // page; this keeps the overview fresh). Stops once terminal.
    refetchInterval: (query) =>
      isInFlight(query.state.data?.latestBuild?.status) ? 4_000 : false,
  });
}
