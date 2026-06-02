import { describe, it, expect } from 'vitest';
import { safeNext, describeOAuthError } from '@/lib/authRedirect';

describe('safeNext (open-redirect guard)', () => {
  it('falls back to /dashboard for null', () => {
    expect(safeNext(null)).toBe('/dashboard');
  });

  it('falls back to /dashboard for an empty string', () => {
    expect(safeNext('')).toBe('/dashboard');
  });

  it('falls back to /dashboard for a path not starting with /', () => {
    expect(safeNext('dashboard')).toBe('/dashboard');
    expect(safeNext('https://evil.com')).toBe('/dashboard');
    expect(safeNext('evil.com')).toBe('/dashboard');
  });

  it('rejects protocol-relative //evil.com smuggling', () => {
    expect(safeNext('//evil.com')).toBe('/dashboard');
    expect(safeNext('//evil.com/path')).toBe('/dashboard');
  });

  it('rejects backslash-smuggled /\\evil.com', () => {
    expect(safeNext('/\\evil.com')).toBe('/dashboard');
    expect(safeNext('/\\/evil.com')).toBe('/dashboard');
  });

  it('rejects any value containing whitespace', () => {
    expect(safeNext('/foo bar')).toBe('/dashboard');
    expect(safeNext('/foo\tbar')).toBe('/dashboard');
    expect(safeNext('/foo\nbar')).toBe('/dashboard');
  });

  it('returns legitimate same-origin paths unchanged', () => {
    expect(safeNext('/dashboard')).toBe('/dashboard');
    expect(safeNext('/projects/123')).toBe('/projects/123');
    expect(safeNext('/deployments?tab=x')).toBe('/deployments?tab=x');
    expect(safeNext('/a/b/c')).toBe('/a/b/c');
  });
});

describe('describeOAuthError', () => {
  it('returns the declined-prompt copy for access_denied', () => {
    expect(describeOAuthError('access_denied')).toContain('declined');
  });

  it('returns the expired copy for oauth_state_mismatch (both cases)', () => {
    expect(describeOAuthError('oauth_state_mismatch')).toContain('expired');
    expect(describeOAuthError('OAUTH_STATE_MISMATCH')).toContain('expired');
  });

  it('returns the generic fallback copy for unknown and empty codes', () => {
    expect(describeOAuthError('something_else')).toContain("couldn't finish");
    expect(describeOAuthError('')).toContain("couldn't finish");
  });
});
