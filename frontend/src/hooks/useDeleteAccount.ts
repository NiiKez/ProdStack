import { useMutation } from '@tanstack/react-query';
import { api } from '@/lib/api';

/**
 * Permanently delete the account, its projects, and their Container Apps.
 * Requires the `X-Confirm: DELETE` header in addition to the X-Requested-With
 * the api() helper adds. The server clears the session on success, so we
 * hard-navigate to '/'.
 */
export function useDeleteAccount() {
  return useMutation<void, Error, void>({
    mutationFn: () =>
      api<void>('/api/account', {
        method: 'DELETE',
        headers: { 'X-Confirm': 'DELETE' },
      }),
    onSuccess: () => {
      window.location.assign('/');
    },
  });
}
