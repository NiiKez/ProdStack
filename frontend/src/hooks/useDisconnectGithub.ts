import { useMutation } from '@tanstack/react-query';
import { api } from '@/lib/api';

/**
 * Disconnect the user's GitHub connection. The server clears the session on
 * success, so we hard-navigate to '/' (like AppLayout's sign-out) rather than
 * invalidating queries that would 401. Fails with 409 `HAS_ACTIVE_PROJECTS`
 * when the user still has projects — that error is surfaced to the caller.
 */
export function useDisconnectGithub() {
  return useMutation<void, Error, void>({
    mutationFn: () => api<void>('/api/account/disconnect-github', { method: 'POST' }),
    onSuccess: () => {
      window.location.assign('/');
    },
  });
}
