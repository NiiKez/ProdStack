import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { CreateProjectInput, ProjectSummary } from '@/types/api';

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation<ProjectSummary, Error, CreateProjectInput>({
    mutationFn: (input) =>
      api<ProjectSummary>('/api/projects', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}
