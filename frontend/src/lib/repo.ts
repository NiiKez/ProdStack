import { ApiError } from '@/lib/api';

// Mirrors the backend regex in `routes/projects.ts` — https only, no trailing
// slash other than the optional `.git`. Keeping them aligned avoids the case
// where the client accepts a URL that the API immediately rejects.
export const REPO_URL_PATTERN =
  /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?(?:\.git)?\/?$/;

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/\.git$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function deriveNameFromRepoUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  const lastSegment = trimmed.split('/').pop() ?? '';
  const withoutGit = lastSegment.replace(/\.git$/, '');
  return withoutGit;
}

export function mapApiError(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'INVALID_REPO_URL':
        return "That doesn't look like a GitHub repo URL.";
      case 'REPO_NOT_ACCESSIBLE':
        return "ProdStack can't see that repo. Check the URL or your GitHub scopes.";
      case 'WEBHOOK_REGISTRATION_FAILED':
        return "Couldn't register the GitHub webhook.";
      case 'DOCKERFILE_NOT_FOUND':
        return 'No Dockerfile at the repo root.';
      default:
        return err.message;
    }
  }
  if (err instanceof Error) return err.message;
  return 'Something went wrong.';
}
