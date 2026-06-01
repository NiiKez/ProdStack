import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { DeploymentListItem } from '@/types/api';

export interface RollbackInput {
  projectId: string;
  deploymentId: string;
}

/**
 * Roll a project back to a previous deployment's image. Works from both the
 * per-project Deployments tab and the cross-project Deployments page, so it
 * takes `projectId` per-call and invalidates every list the result touches.
 */
export function useRollbackDeployment() {
  const qc = useQueryClient();
  return useMutation<DeploymentListItem, Error, RollbackInput>({
    mutationFn: ({ projectId, deploymentId }) =>
      api<DeploymentListItem>(
        `/api/projects/${projectId}/deployments/${deploymentId}/rollback`,
        { method: 'POST' },
      ),
    onSuccess: (_data, { projectId }) => {
      qc.invalidateQueries({ queryKey: ['project-deployments', projectId] });
      qc.invalidateQueries({ queryKey: ['project', projectId] });
      qc.invalidateQueries({ queryKey: ['deployments'] });
      qc.invalidateQueries({ queryKey: ['projects'] });
      qc.invalidateQueries({ queryKey: ['activity'] });
    },
  });
}
