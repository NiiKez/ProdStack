import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { CancelBuildResult } from '@/types/api';

export interface CancelBuildInput {
  buildId: string;
  /** When known, lets us invalidate the owning project's lists too. */
  projectId?: string;
}

/**
 * Request cancellation of an in-flight build (M5 #8). Cooperative: the worker
 * polls `cancelRequested` and stops at the next checkpoint. Works from both the
 * Build Logs page and the project Overview, so it takes the ids per-call and
 * invalidates every list the result touches.
 */
export function useCancelBuild() {
  const qc = useQueryClient();
  return useMutation<CancelBuildResult, Error, CancelBuildInput>({
    mutationFn: ({ buildId }) =>
      api<CancelBuildResult>(`/api/builds/${buildId}/cancel`, { method: 'POST' }),
    onSuccess: (_data, { buildId, projectId }) => {
      qc.invalidateQueries({ queryKey: ['build', buildId] });
      if (projectId) {
        qc.invalidateQueries({ queryKey: ['project', projectId] });
        qc.invalidateQueries({ queryKey: ['project-builds', projectId] });
      }
      qc.invalidateQueries({ queryKey: ['projects'] });
      qc.invalidateQueries({ queryKey: ['activity'] });
    },
  });
}
