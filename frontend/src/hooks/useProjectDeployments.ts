import { useInfiniteQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { DeploymentListItem, Paginated } from '@/types/api';

const PAGE_SIZE = 20;

export function useProjectDeployments(
  projectId: string | undefined,
  opts: { activeOnly?: boolean } = {},
) {
  return useInfiniteQuery<Paginated<DeploymentListItem>>({
    queryKey: ['project-deployments', projectId, opts],
    enabled: Boolean(projectId),
    initialPageParam: undefined,
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams();
      qs.set('limit', String(PAGE_SIZE));
      if (opts.activeOnly) qs.set('activeOnly', 'true');
      if (pageParam) qs.set('cursor', pageParam as string);
      return api<Paginated<DeploymentListItem>>(
        `/api/projects/${projectId}/deployments?${qs}`,
      );
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}
