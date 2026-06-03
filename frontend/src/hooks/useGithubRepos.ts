import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { GithubRepo } from '@/types/api';

/**
 * `GET /api/github/repos` — the signed-in user's GitHub repositories for the
 * New Project picker. The API wraps the list as `{ repos: [...] }`; we unwrap
 * to the array the picker consumes (tolerating a bare array for safety).
 *
 * Lazy: `enabled` gates the fetch so it only fires when the picker actually
 * needs the data (e.g. when the modal opens). No polling — repos rarely change
 * mid-session — and a generous `staleTime` avoids a refetch each time the modal
 * reopens. On error, `isError` drives the modal's fallback to manual URL entry.
 */
export function useGithubRepos(enabled = true) {
  return useQuery<GithubRepo[]>({
    queryKey: ['github', 'repos'],
    queryFn: async () => {
      const data = await api<GithubRepo[] | { repos: GithubRepo[] }>('/api/github/repos');
      return Array.isArray(data) ? data : data.repos;
    },
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}
