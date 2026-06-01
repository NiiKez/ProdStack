import { useInfiniteQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { ActivityEvent, Paginated } from '@/types/api';

export interface ActivityFilters {
  projectId?: string;
  /** ActivityType values, e.g. ['build.failed','deployment.rollback']. */
  type?: string[];
}

const PAGE_SIZE = 30;

export function useActivity(filters: ActivityFilters = {}) {
  return useInfiniteQuery<Paginated<ActivityEvent>>({
    queryKey: ['activity', filters],
    initialPageParam: undefined,
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams();
      if (filters.projectId) qs.set('projectId', filters.projectId);
      if (filters.type && filters.type.length > 0) qs.set('type', filters.type.join(','));
      qs.set('limit', String(PAGE_SIZE));
      // Activity uses an opaque composite (ts,id) keyset cursor.
      if (pageParam) qs.set('cursor', pageParam as string);
      return api<Paginated<ActivityEvent>>(`/api/activity?${qs}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 30_000,
  });
}
