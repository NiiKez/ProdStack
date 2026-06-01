import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { isInFlight } from '@/lib/status';
import type { ProjectSummary } from '@/types/api';

export function useProjects() {
  return useQuery<ProjectSummary[]>({
    queryKey: ['projects'],
    // The API wraps the list as `{ projects: [...] }`; unwrap to the array the
    // UI consumes. Tolerates a bare-array response too, for safety.
    queryFn: async () => {
      const data = await api<ProjectSummary[] | { projects: ProjectSummary[] }>('/api/projects');
      return Array.isArray(data) ? data : data.projects;
    },
    // Function form — TanStack re-evaluates per tick so the polling pauses
    // when the tab is hidden and resumes when it comes back. Polls fast (5s)
    // while any project has an in-flight build so dashboard status pills
    // advance through build stages; falls back to a lazy 30s otherwise.
    refetchInterval: (query) => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
        return false;
      }
      const projects = query.state.data;
      const anyInFlight = Array.isArray(projects)
        ? projects.some((p) => isInFlight(p.latestBuild?.status))
        : false;
      return anyInFlight ? 5_000 : 30_000;
    },
  });
}
