import { describe, it, expect } from 'vitest';
import { filterRepos, repoToFormValues, REPO_DISPLAY_CAP } from '@/lib/githubRepos';
import type { GithubRepo } from '@/types/api';

function repo(overrides: Partial<GithubRepo> = {}): GithubRepo {
  return {
    fullName: 'octocat/hello-world',
    url: 'https://github.com/octocat/hello-world',
    defaultBranch: 'main',
    private: false,
    ...overrides,
  };
}

const sample: GithubRepo[] = [
  repo({ fullName: 'octocat/alpha-service', url: 'https://github.com/octocat/alpha-service' }),
  repo({ fullName: 'octocat/Beta-Worker', url: 'https://github.com/octocat/Beta-Worker' }),
  repo({ fullName: 'acme/gamma', url: 'https://github.com/acme/gamma' }),
];

describe('filterRepos', () => {
  it('returns all repos for an empty query, preserving input order', () => {
    expect(filterRepos(sample, '')).toEqual(sample);
  });

  it('returns all repos for a whitespace-only query', () => {
    expect(filterRepos(sample, '   ')).toEqual(sample);
  });

  it('matches case-insensitively on fullName', () => {
    expect(filterRepos(sample, 'beta').map((r) => r.fullName)).toEqual(['octocat/Beta-Worker']);
    expect(filterRepos(sample, 'BETA').map((r) => r.fullName)).toEqual(['octocat/Beta-Worker']);
  });

  it('matches a substring anywhere in fullName (owner or repo segment)', () => {
    expect(filterRepos(sample, 'octocat').map((r) => r.fullName)).toEqual([
      'octocat/alpha-service',
      'octocat/Beta-Worker',
    ]);
    expect(filterRepos(sample, 'gamma').map((r) => r.fullName)).toEqual(['acme/gamma']);
  });

  it('preserves input order among matches', () => {
    expect(filterRepos(sample, 'a').map((r) => r.fullName)).toEqual([
      'octocat/alpha-service',
      'octocat/Beta-Worker',
      'acme/gamma',
    ]);
  });

  it('returns an empty array when nothing matches', () => {
    expect(filterRepos(sample, 'zzz-nope')).toEqual([]);
  });

  it('trims surrounding whitespace from the query before matching', () => {
    expect(filterRepos(sample, '  gamma  ').map((r) => r.fullName)).toEqual(['acme/gamma']);
  });

  it('caps the result at REPO_DISPLAY_CAP', () => {
    const many = Array.from({ length: REPO_DISPLAY_CAP + 10 }, (_, i) =>
      repo({ fullName: `octocat/repo-${i}`, url: `https://github.com/octocat/repo-${i}` })
    );
    expect(filterRepos(many, '')).toHaveLength(REPO_DISPLAY_CAP);
    // The cap is applied after filtering, so a narrowing query still surfaces
    // matches that sit beyond the cap in the unfiltered list.
    expect(filterRepos(many, 'repo-55').map((r) => r.fullName)).toEqual(['octocat/repo-55']);
  });
});

describe('repoToFormValues', () => {
  it('maps url, defaultBranch, and derived name', () => {
    expect(
      repoToFormValues(
        repo({
          fullName: 'octocat/hello-world',
          url: 'https://github.com/octocat/hello-world',
          defaultBranch: 'develop',
        })
      )
    ).toEqual({
      repoUrl: 'https://github.com/octocat/hello-world',
      branch: 'develop',
      name: 'hello-world',
    });
  });

  it('falls back to "main" when defaultBranch is empty', () => {
    expect(repoToFormValues(repo({ defaultBranch: '' })).branch).toBe('main');
  });

  it('derives the name from the repo URL segment (matches deriveNameFromRepoUrl)', () => {
    expect(
      repoToFormValues(repo({ url: 'https://github.com/owner/my-cool-repo.git' })).name
    ).toBe('my-cool-repo');
  });

  it('uses the repo url verbatim as repoUrl', () => {
    const r = repo({ url: 'https://github.com/owner/repo' });
    expect(repoToFormValues(r).repoUrl).toBe('https://github.com/owner/repo');
  });
});
