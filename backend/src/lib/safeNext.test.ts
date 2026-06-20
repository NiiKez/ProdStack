import { describe, expect, it } from 'vitest';

import { isSafeNextPath } from './safeNext.js';

// The shared open-redirect guard used by both the OAuth callback (auth.ts) and
// demo-login (demoAuth.ts). It was duplicated verbatim in both routers; this
// suite is the single regression net so a future tweak to one call site can't
// silently weaken the other.
describe('isSafeNextPath', () => {
  it('accepts ordinary same-origin paths', () => {
    for (const ok of [
      '/',
      '/dashboard',
      '/projects',
      '/projects?tab=builds',
      '/projects/abc-123?tab=x#frag',
      '/a/b/c~d_e-f.g',
      '/path%20with%20encoded',
      '/a:b', // a colon AFTER the first char is allowed (e.g. a matrix param)
    ]) {
      expect(isSafeNextPath(ok), ok).toBe(true);
    }
  });

  it('rejects protocol-relative and off-site targets (the core open-redirect vectors)', () => {
    for (const bad of [
      '//evil.com',
      '//evil.com/path',
      '/\\evil.com', // backslash separator — browsers normalize to //
      'https://evil.com',
      'http://evil.com',
      'javascript:alert(1)',
      'mailto:x@y.com',
    ]) {
      expect(isSafeNextPath(bad), bad).toBe(false);
    }
  });

  it('rejects whitespace (incl. CR/LF that could enable response-splitting)', () => {
    for (const bad of ['/a b', '/a\tb', '/a\nb', '/a\rb', '/ x', ' /leading-space']) {
      expect(isSafeNextPath(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('rejects empty, non-/-leading, and over-length values', () => {
    expect(isSafeNextPath('')).toBe(false);
    expect(isSafeNextPath('dashboard')).toBe(false);
    expect(isSafeNextPath('relative/path')).toBe(false);
    expect(isSafeNextPath('/' + 'a'.repeat(512))).toBe(false); // 513 chars total
    expect(isSafeNextPath('/' + 'a'.repeat(511))).toBe(true); // exactly 512 — boundary
  });
});
