import { useInfiniteQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { isInFlight } from '@/lib/status';
import type { BuildListItem, Paginated } from '@/types/api';

export interface BuildFilters {
  /** Uppercase BuildStatus values, e.g. ['READY','FAILED']. */
  status?: string[];
  branch?: string;
  sort?: 'created' | 'duration';
  order?: 'asc' | 'desc';
  /** ISO timestamp lower bound on createdAt. */
  since?: string;
}

const PAGE_SIZE = 20;

function buildQuery(filters: BuildFilters, cursor?: string): string {
  const qs = new URLSearchParams();
  if (filters.status && filters.status.length > 0) qs.set('status', filters.status.join(','));
  if (filters.branch) qs.set('branch', filters.branch);
  if (filters.sort) qs.set('sort', filters.sort);
  if (filters.order) qs.set('order', filters.order);
  if (filters.since) qs.set('since', filters.since);
  qs.set('limit', String(PAGE_SIZE));
  if (cursor) qs.set('cursor', cursor);
  return qs.toString();
}

export function useProjectBuilds(projectId: string | undefined, filters: BuildFilters = {}) {
  return useInfiniteQuery<Paginated<BuildListItem>>({
    queryKey: ['project-builds', projectId, filters],
    enabled: Boolean(projectId),
    initialPageParam: undefined,
    queryFn: ({ pageParam }) =>
      api<Paginated<BuildListItem>>(
        `/api/projects/${projectId}/builds?${buildQuery(filters, pageParam as string | undefined)}`,
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    // Poll while the newest build is in-flight so its status advances through
    // stages in the table without a manual refresh; stop once everything is
    // terminal. Only the first page's head can be in-flight (newest first).
    refetchInterval: (query) => {
      const first = query.state.data?.pages[0]?.items[0];
      return isInFlight(first?.status) ? 5_000 : false;
    },
  });
}
