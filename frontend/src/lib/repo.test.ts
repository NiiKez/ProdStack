import { describe, it, expect } from 'vitest';
import { ApiError } from '@/lib/api';
import { REPO_URL_PATTERN, slugify, deriveNameFromRepoUrl, mapApiError } from '@/lib/repo';

describe('REPO_URL_PATTERN', () => {
  const accept = [
    'https://github.com/owner/repo',
    'https://github.com/owner/repo.git',
    'https://github.com/owner/repo/',
    'https://github.com/owner/repo.git/',
    'https://github.com/my-owner/my_repo.name',
    'https://github.com/a.b-c/d.e_f-g',
    'https://github.com/Owner123/Repo456',
  ];

  const reject = [
    'http://github.com/owner/repo', // not https
    'https://github.com/owner', // missing repo segment
    'https://gitlab.com/owner/repo', // non-github host
    'https://github.com/owner/repo/extra', // trailing junk (extra segment)
    'https://github.com/owner/repo junk', // trailing space + junk
    'https://github.com/owner /repo', // space in owner
    'git@github.com:owner/repo.git', // ssh URL
    '', // empty
  ];

  it.each(accept)('accepts %s', (url) => {
    expect(REPO_URL_PATTERN.test(url)).toBe(true);
  });

  it.each(reject)('rejects %s', (url) => {
    expect(REPO_URL_PATTERN.test(url)).toBe(false);
  });
});

describe('slugify', () => {
  it('lowercases uppercase input', () => {
    expect(slugify('MyApp')).toBe('myapp');
  });

  it('replaces spaces and punctuation with single dashes', () => {
    expect(slugify('my cool app')).toBe('my-cool-app');
    expect(slugify('my.cool!app')).toBe('my-cool-app');
  });

  it('strips leading and trailing dashes', () => {
    expect(slugify('  hello world  ')).toBe('hello-world');
    expect(slugify('---hello---')).toBe('hello');
    expect(slugify('!!!edge!!!')).toBe('edge');
  });

  it('strips a trailing .git', () => {
    expect(slugify('my-repo.git')).toBe('my-repo');
  });

  it('collapses repeated separators', () => {
    expect(slugify('a   b___c...d')).toBe('a-b-c-d');
  });
});

describe('deriveNameFromRepoUrl', () => {
  it('extracts the last path segment', () => {
    expect(deriveNameFromRepoUrl('https://github.com/owner/repo')).toBe('repo');
  });

  it('strips a trailing .git', () => {
    expect(deriveNameFromRepoUrl('https://github.com/owner/repo.git')).toBe('repo');
  });

  it('handles trailing slashes', () => {
    expect(deriveNameFromRepoUrl('https://github.com/owner/repo/')).toBe('repo');
    expect(deriveNameFromRepoUrl('https://github.com/owner/repo.git/')).toBe('repo');
    expect(deriveNameFromRepoUrl('https://github.com/owner/repo///')).toBe('repo');
  });

  it('returns empty string for empty or whitespace-only input', () => {
    expect(deriveNameFromRepoUrl('')).toBe('');
    expect(deriveNameFromRepoUrl('   ')).toBe('');
  });
});

describe('mapApiError', () => {
  it('maps INVALID_REPO_URL to friendly copy', () => {
    const err = new ApiError(400, 'INVALID_REPO_URL', 'raw message');
    expect(mapApiError(err)).toBe("That doesn't look like a GitHub repo URL.");
  });

  it('maps REPO_NOT_ACCESSIBLE to friendly copy', () => {
    const err = new ApiError(403, 'REPO_NOT_ACCESSIBLE', 'raw message');
    expect(mapApiError(err)).toBe(
      "ProdStack can't see that repo. Check the URL or your GitHub scopes.",
    );
  });

  it('maps WEBHOOK_REGISTRATION_FAILED to friendly copy', () => {
    const err = new ApiError(502, 'WEBHOOK_REGISTRATION_FAILED', 'raw message');
    expect(mapApiError(err)).toBe("Couldn't register the GitHub webhook.");
  });

  it('maps DOCKERFILE_NOT_FOUND to friendly copy', () => {
    const err = new ApiError(422, 'DOCKERFILE_NOT_FOUND', 'raw message');
    expect(mapApiError(err)).toBe('No Dockerfile at the repo root.');
  });

  it('returns err.message for an unmapped ApiError code', () => {
    const err = new ApiError(500, 'SOMETHING_ELSE', 'the raw message');
    expect(mapApiError(err)).toBe('the raw message');
  });

  it('returns the message for a plain Error', () => {
    expect(mapApiError(new Error('boom'))).toBe('boom');
  });

  it('returns a generic fallback for a non-Error value', () => {
    expect(mapApiError('just a string')).toBe('Something went wrong.');
    expect(mapApiError(null)).toBe('Something went wrong.');
    expect(mapApiError(undefined)).toBe('Something went wrong.');
    expect(mapApiError({ code: 'INVALID_REPO_URL' })).toBe('Something went wrong.');
  });
});
