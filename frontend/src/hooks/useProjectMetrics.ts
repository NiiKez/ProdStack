import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { AppMetrics, MetricRange } from '@/lib/metrics';

/**
 * Azure Monitor metrics (CPU / memory / replicas / requests) for a project's
 * Container App. Polls every 30s while the Metrics tab is mounted+enabled so
 * the charts advance live (including the scale-to-zero replica count). The
 * backend serves stub series in dev so this works without real Azure.
 */
export function useProjectMetrics(
  id: string | undefined,
  range: MetricRange,
  enabled = true,
) {
  return useQuery<AppMetrics>({
    queryKey: ['project-metrics', id, range],
    queryFn: () => api<AppMetrics>(`/api/projects/${id}/metrics?range=${range}`),
    enabled: Boolean(id) && enabled,
    refetchInterval: 30_000,
  });
}
