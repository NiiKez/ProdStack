import { deriveNameFromRepoUrl } from '@/lib/repo';
import type { GithubRepo } from '@/types/api';

/**
 * Max repos rendered in the picker list at once. The backend returns repos
 * most-recently-pushed first, so an unfiltered list shows the freshest ones;
 * typing in the search narrows the (already capped) view. Keeping a cap keeps
 * the dropdown snappy for accounts with hundreds of repos. Pure/deterministic:
 * the slice is applied AFTER filtering so a match further down the list still
 * surfaces once the query narrows the set.
 */
export const REPO_DISPLAY_CAP = 50;

/**
 * Case-insensitive substring filter on `fullName`, preserving the input order
 * (which the backend has already sorted most-recently-pushed first). An
 * empty / whitespace-only query returns every repo. The result is capped at
 * `REPO_DISPLAY_CAP` so the rendered list stays bounded.
 */
export function filterRepos(repos: GithubRepo[], query: string): GithubRepo[] {
  const needle = query.trim().toLowerCase();
  const matched = needle
    ? repos.filter((r) => r.fullName.toLowerCase().includes(needle))
    : repos;
  return matched.slice(0, REPO_DISPLAY_CAP);
}

/**
 * Map a picked repo onto the New Project form fields. `repoUrl` is the repo's
 * clone/web URL, `branch` falls back to `main` when the repo reports no default
 * branch, and `name` reuses `deriveNameFromRepoUrl` so it matches what the
 * manual-URL onBlur derivation would produce for the same URL.
 */
export function repoToFormValues(repo: GithubRepo): {
  repoUrl: string;
  branch: string;
  name: string;
} {
  return {
    repoUrl: repo.url,
    branch: repo.defaultBranch || 'main',
    name: deriveNameFromRepoUrl(repo.url),
  };
}
