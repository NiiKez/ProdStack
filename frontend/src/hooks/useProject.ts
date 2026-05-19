import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { ProjectDetail } from '@/types/api';

export function useProject(id: string | undefined) {
  return useQuery<ProjectDetail>({
    queryKey: ['project', id],
    queryFn: () => api<ProjectDetail>(`/api/projects/${id}`),
    enabled: Boolean(id),
  });
}
