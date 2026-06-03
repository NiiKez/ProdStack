import { useMutation } from '@tanstack/react-query';
import { api, type ApiError } from '@/lib/api';
import type { DetectFrameworkResult } from '@/types/api';

/**
 * Preview what we'd build for a repo (`POST /api/github/detect`) — the user's
 * own Dockerfile, an auto-detected framework + port, or "unknown" — without
 * cloning. Called when a repo is picked in the New Project modal. Failures
 * (e.g. the dev-login user's tokenless account → 502) are non-fatal: the modal
 * just hides the preview, so consumers can ignore the error.
 */
export function useDetectFramework() {
  return useMutation<DetectFrameworkResult, ApiError, { repoUrl: string; ref?: string }>({
    mutationFn: (body) =>
      api<DetectFrameworkResult>('/api/github/detect', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  });
}
