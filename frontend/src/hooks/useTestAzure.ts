import { useMutation } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { AzureTestResult } from '@/types/api';

/**
 * Ping Azure to verify the managed-identity (or stub) connection. Always
 * resolves with HTTP 200; check `result.ok` for success vs failure.
 */
export function useTestAzure() {
  return useMutation<AzureTestResult, Error, void>({
    mutationFn: () => api<AzureTestResult>('/api/account/azure/test', { method: 'POST' }),
  });
}
