import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { RebuildResult } from '@/types/api';

/**
 * Manually trigger a build of the project's latest commit (M5 #7). The backend
 * enqueues a QUEUED build the same way a webhook push would, so on success we
 * navigate to its logs page. Invalidates every list the new build touches.
 */
export function useRebuildProject() {
  const qc = useQueryClient();
  return useMutation<RebuildResult, Error, string>({
    mutationFn: (projectId) =>
      api<RebuildResult>(`/api/projects/${projectId}/rebuild`, { method: 'POST' }),
    onSuccess: (_data, projectId) => {
      qc.invalidateQueries({ queryKey: ['project', projectId] });
      qc.invalidateQueries({ queryKey: ['project-builds', projectId] });
      qc.invalidateQueries({ queryKey: ['projects'] });
      qc.invalidateQueries({ queryKey: ['activity'] });
    },
  });
}
