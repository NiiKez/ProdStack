import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { StopProjectResult } from '@/types/api';

/**
 * Pause a project's deployed Azure app (Stop). The backend hard-stops the
 * Container App (0 replicas, won't wake on traffic — not scale-to-zero) so the
 * live URL goes dark at $0 compute, then flips the project to `STOPPED`.
 * Rejected with 409 `BUILD_IN_PROGRESS` while a build is running.
 * On success we refresh the project + its lists so the header status badge and
 * dashboard reflect the new state immediately.
 */
export function useStopProject() {
  const qc = useQueryClient();
  return useMutation<StopProjectResult, Error, string>({
    mutationFn: (projectId) =>
      api<StopProjectResult>(`/api/projects/${projectId}/stop`, { method: 'POST' }),
    onSuccess: (_data, projectId) => {
      qc.invalidateQueries({ queryKey: ['project', projectId] });
      qc.invalidateQueries({ queryKey: ['projects'] });
      qc.invalidateQueries({ queryKey: ['activity'] });
    },
  });
}
