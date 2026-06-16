import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { ResumeProjectResult } from '@/types/api';

/**
 * Bring a stopped project back online (Resume). The backend flips it to
 * `ACTIVE` and, when auto-deploy is on, queues a build of the newest commit —
 * returned as `resumedBuild`. We invalidate the project + builds + lists so the
 * header badge, builds tab, and dashboard advance; the caller decides whether
 * to navigate to the queued build's logs.
 */
export function useResumeProject() {
  const qc = useQueryClient();
  return useMutation<ResumeProjectResult, Error, string>({
    mutationFn: (projectId) =>
      api<ResumeProjectResult>(`/api/projects/${projectId}/resume`, { method: 'POST' }),
    onSuccess: (_data, projectId) => {
      qc.invalidateQueries({ queryKey: ['project', projectId] });
      qc.invalidateQueries({ queryKey: ['project-builds', projectId] });
      qc.invalidateQueries({ queryKey: ['projects'] });
      qc.invalidateQueries({ queryKey: ['activity'] });
    },
  });
}
