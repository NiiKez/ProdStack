import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { PreviewSummary } from '@/types/api';

/** Poll interval (ms) while any preview is PENDING, else stop. Pure + exported
 * for unit testing — this predicate is the hook's whole reason for existing. */
export function previewsRefetchInterval(data: PreviewSummary[] | undefined): number | false {
  return (data ?? []).some((p) => p.status === 'PENDING') ? 5_000 : false;
}

/**
 * List a project's preview / PR environments. Polls every 5s while ANY preview
 * is still PENDING (its first build in flight) so the status badge + live URL
 * appear as soon as the deploy lands, then stops — mirrors `useProject`'s
 * in-flight polling.
 */
export function usePreviews(projectId: string | undefined) {
  return useQuery<PreviewSummary[]>({
    queryKey: ['project-previews', projectId],
    queryFn: async () => {
      const res = await api<{ previews: PreviewSummary[] }>(
        `/api/projects/${projectId}/previews`,
      );
      return res.previews;
    },
    enabled: Boolean(projectId),
    refetchInterval: (query) => previewsRefetchInterval(query.state.data),
  });
}

/**
 * Manually tear down a preview (delete its Container App + mark TORN_DOWN).
 * Refreshes the previews list + the project on success.
 */
export function useTeardownPreview(projectId: string) {
  const qc = useQueryClient();
  return useMutation<PreviewSummary, Error, string>({
    mutationFn: (previewId) =>
      api<PreviewSummary>(`/api/projects/${projectId}/previews/${previewId}/teardown`, {
        method: 'POST',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project-previews', projectId] });
      qc.invalidateQueries({ queryKey: ['project', projectId] });
    },
  });
}
