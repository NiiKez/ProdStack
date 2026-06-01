import { useInfiniteQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { CrossProjectDeployment, Paginated } from '@/types/api';

export interface DeploymentFilters {
  projectId?: string[];
  /** Uppercase BuildStatus values. */
  status?: string[];
  activeOnly?: boolean;
}

const PAGE_SIZE = 20;

export function useDeployments(filters: DeploymentFilters = {}) {
  return useInfiniteQuery<Paginated<CrossProjectDeployment>>({
    queryKey: ['deployments', filters],
    initialPageParam: undefined,
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams();
      if (filters.projectId && filters.projectId.length > 0) {
        qs.set('projectId', filters.projectId.join(','));
      }
      if (filters.status && filters.status.length > 0) qs.set('status', filters.status.join(','));
      if (filters.activeOnly) qs.set('activeOnly', 'true');
      qs.set('limit', String(PAGE_SIZE));
      if (pageParam) qs.set('cursor', pageParam as string);
      return api<Paginated<CrossProjectDeployment>>(`/api/deployments?${qs}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 30_000,
  });
}
