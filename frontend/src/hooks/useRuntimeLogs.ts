import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { RuntimeLogsResult } from '@/types/api';

/**
 * The running container's stdout/stderr (`GET …/runtime/logs`).
 *
 * Unlike the build-log SSE stream (logs live in Postgres → instant), runtime
 * logs come from Azure Log Analytics, which has a short ingestion delay and a
 * per-query cost. So we poll a bounded snapshot (last `sinceMinutes`) every 8s
 * and replace, rather than holding an SSE open that hammers the workspace.
 * `enabled` is wired to "the Logs tab is active" so we don't query in the
 * background.
 */
export function useRuntimeLogs(
  id: string | undefined,
  opts: { sinceMinutes?: number; enabled?: boolean } = {},
) {
  const sinceMinutes = opts.sinceMinutes ?? 15;
  return useQuery<RuntimeLogsResult>({
    queryKey: ['runtime-logs', id, sinceMinutes],
    queryFn: () =>
      api<RuntimeLogsResult>(`/api/projects/${id}/runtime/logs?sinceMinutes=${sinceMinutes}`),
    enabled: Boolean(id) && (opts.enabled ?? true),
    refetchInterval: 8_000,
  });
}
