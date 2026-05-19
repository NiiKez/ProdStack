import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { ProjectSummary } from '@/types/api';

export function useProjects() {
  return useQuery<ProjectSummary[]>({
    queryKey: ['projects'],
    queryFn: () => api<ProjectSummary[]>('/api/projects'),
    // Function form — TanStack re-evaluates per tick so the polling pauses
    // when the tab is hidden and resumes when it comes back.
    refetchInterval: () =>
      typeof document !== 'undefined' && document.visibilityState === 'visible'
        ? 30_000
        : false,
  });
}
