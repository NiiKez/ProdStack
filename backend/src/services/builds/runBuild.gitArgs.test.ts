// Security-hardening unit tests for the git arg builders in runBuild.
//
// The commit SHA reaches `git fetch`/`git checkout` as a positional. Git parses
// a leading-dash positional as an option (e.g. `--upload-pack=<cmd>` → arbitrary
// command execution — a verified RCE on the builder's Contributor/AcrPush/KV
// managed identity). Two layers defend this:
//   1. `assertValidCommitSha` throws before any git process is spawned.
//   2. `--end-of-options` immediately precedes every user-controlled positional
//      so git can never reinterpret data as an option.
// These helpers are pure (the kaniko.ts/buildCommand pattern), so we assert the
// exact argv shape without spawning git or needing a docker daemon.
import { describe, expect, it } from 'vitest';

import {
  assertValidCommitSha,
  checkoutArgs,
  cloneArgs,
  fetchArgs,
} from './runBuild.js';

const VALID_SHA = '0123456789abcdef0123456789abcdef01234567';
const VALID_SHORT_SHA = 'abc1234';

describe('assertValidCommitSha', () => {
  it('accepts a full 40-char lowercase hex SHA-1', () => {
    expect(() => assertValidCommitSha(VALID_SHA)).not.toThrow();
  });

  it('accepts a 7-char short sha and a 64-char SHA-256', () => {
    expect(() => assertValidCommitSha(VALID_SHORT_SHA)).not.toThrow();
    expect(() => assertValidCommitSha('a'.repeat(64))).not.toThrow();
  });

  it('throws on a git-option injection payload (before any git spawn)', () => {
    expect(() => assertValidCommitSha('--upload-pack=touch /tmp/x')).toThrow(
      /invalid commit sha/,
    );
  });

  it('throws on non-hex, uppercase, too-short, and too-long values', () => {
    expect(() => assertValidCommitSha('ZZZZ-not-a-sha')).toThrow(/invalid commit sha/);
    expect(() => assertValidCommitSha('ABCDEF0123456789ABCDEF0123456789ABCDEF01')).toThrow(
      /invalid commit sha/,
    );
    expect(() => assertValidCommitSha('abc123')).toThrow(/invalid commit sha/); // 6 chars
    expect(() => assertValidCommitSha('a'.repeat(65))).toThrow(/invalid commit sha/);
    expect(() => assertValidCommitSha('')).toThrow(/invalid commit sha/);
  });
});

/** Index of `value` in `args`, asserting it appears immediately after `flag`. */
function expectEndOfOptionsBefore(args: string[], value: string): void {
  const valueIdx = args.indexOf(value);
  expect(valueIdx).toBeGreaterThan(-1);
  expect(args[valueIdx - 1]).toBe('--end-of-options');
}

describe('cloneArgs', () => {
  it('places --end-of-options before the url/dir positionals', () => {
    const args = cloneArgs({
      noCredHelper: 'credential.helper=',
      authConfig: 'http.https://github.com/o/r.git.extraheader=AUTHORIZATION: Basic xxx',
      branch: 'main',
      url: 'https://github.com/o/r.git',
      intoDir: '/var/builds/b1/repo',
    });
    const eooIdx = args.indexOf('--end-of-options');
    const urlIdx = args.indexOf('https://github.com/o/r.git');
    const dirIdx = args.indexOf('/var/builds/b1/repo');
    expect(eooIdx).toBeGreaterThan(-1);
    // --end-of-options immediately precedes the first positional (the url),
    // which is immediately followed by the dir — both protected.
    expect(args[eooIdx + 1]).toBe('https://github.com/o/r.git');
    expect(args[eooIdx + 2]).toBe('/var/builds/b1/repo');
    expect(urlIdx).toBe(eooIdx + 1);
    expect(dirIdx).toBe(eooIdx + 2);
    // --branch's value is still consumed as an option-arg ahead of the guard.
    expect(args.indexOf('--branch')).toBeLessThan(eooIdx);
  });

  it('omits the auth -c pair on the anonymous retry but keeps the guard', () => {
    const args = cloneArgs({
      noCredHelper: 'credential.helper=',
      branch: 'main',
      url: 'https://github.com/o/r.git',
      intoDir: '/var/builds/b1/repo',
    });
    // Only the noCredHelper -c remains.
    expect(args.filter((a) => a === '-c')).toHaveLength(1);
    expect(args).toContain('--end-of-options');
    expectEndOfOptionsBefore(args, 'https://github.com/o/r.git');
  });
});

describe('fetchArgs', () => {
  it('places --end-of-options immediately before the commit sha', () => {
    const args = fetchArgs({
      intoDir: '/var/builds/b1/repo',
      noCredHelper: 'credential.helper=',
      authConfig: 'http.https://github.com/o/r.git.extraheader=AUTHORIZATION: Basic xxx',
      commitSha: VALID_SHA,
    });
    expect(args).toContain('fetch');
    expect(args[args.indexOf('origin') + 1]).toBe('--end-of-options');
    expectEndOfOptionsBefore(args, VALID_SHA);
    // The sha is the final positional.
    expect(args[args.length - 1]).toBe(VALID_SHA);
  });

  it('keeps a malicious-looking sha guarded by --end-of-options (positional, never an option)', () => {
    // fetchArgs is pure and does not validate; the guard is what neutralizes a
    // dash-leading value if it ever reached here. (assertValidCommitSha is the
    // first line of defense and is tested above.)
    const evil = '--upload-pack=touch /tmp/x';
    const args = fetchArgs({
      intoDir: '/var/builds/b1/repo',
      noCredHelper: 'credential.helper=',
      authConfig: 'http....extraheader=x',
      commitSha: evil,
    });
    expectEndOfOptionsBefore(args, evil);
    expect(args[args.length - 1]).toBe(evil);
  });
});

describe('checkoutArgs', () => {
  it('places --end-of-options immediately before the commit sha', () => {
    const args = checkoutArgs({ intoDir: '/var/builds/b1/repo', commitSha: VALID_SHA });
    expect(args).toEqual([
      '-C',
      '/var/builds/b1/repo',
      'checkout',
      '--end-of-options',
      VALID_SHA,
    ]);
  });
});
