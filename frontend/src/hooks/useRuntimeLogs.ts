import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { RuntimeLogsResult } from '@/types/api';

/**
 * Auto-refresh cadence for the runtime-log snapshot, scaled to the look-back
 * window (returns `false` when auto-refresh is off). Each poll re-queries the
 * whole window from Azure Log Analytics, so a fixed 8s tick would re-scan *days*
 * of logs every few seconds on a wide range for no real benefit. Narrow windows
 * are a near-live tail (poll fast); past 24h is historical review, so we turn
 * auto-refresh off and lean on the manual Refresh button. Cutoffs line up with
 * the Logs-tab range picker (15m/1h → fast, 6h/24h → gentle, 7d/30d → manual).
 */
export function logsPollIntervalMs(sinceMinutes: number): number | false {
  if (sinceMinutes <= 60) return 8_000;
  if (sinceMinutes <= 1440) return 30_000;
  return false;
}

/**
 * The running container's stdout/stderr (`GET …/runtime/logs`).
 *
 * Unlike the build-log SSE stream (logs live in Postgres → instant), runtime
 * logs come from Azure Log Analytics, which has a short ingestion delay and a
 * per-query cost. So we poll a bounded snapshot (last `sinceMinutes`) and
 * replace, rather than holding an SSE open that hammers the workspace. The poll
 * cadence scales with the window (`logsPollIntervalMs`). `enabled` is wired to
 * "the Logs tab is active" so we don't query in the background.
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
    // If the backend reports `available:false` (no Log Analytics workspace, app
    // scaled to zero, …) stop polling — the answer won't change until the user
    // reopens the tab (which refetches on mount anyway). Otherwise poll at the
    // range-scaled cadence.
    refetchInterval: (query) =>
      query.state.data?.available === false ? false : logsPollIntervalMs(sinceMinutes),
  });
}
