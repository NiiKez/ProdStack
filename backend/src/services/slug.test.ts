import { describe, expect, it } from 'vitest';

import { containerAppName, dedupedSlug, slugify } from './slug.js';

const CONTAINER_APP_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

describe('slugify', () => {
  it('lowercases and replaces spaces', () => {
    expect(slugify('My Cool App')).toBe('my-cool-app');
  });

  it('strips accents', () => {
    expect(slugify('Café Déjà Vu')).toBe('cafe-deja-vu');
  });

  it('removes emojis and stray symbols', () => {
    expect(slugify('hello 🌍 world!!')).toBe('hello-world');
  });

  it('collapses repeated separators', () => {
    expect(slugify('a----b___c   d')).toBe('a-b-c-d');
  });

  it('trims separators from edges', () => {
    expect(slugify('---abc---')).toBe('abc');
  });

  it('falls back to "project" for all-symbol input', () => {
    expect(slugify('!!!')).toBe('project');
  });

  it('falls back to "project" for empty string', () => {
    expect(slugify('')).toBe('project');
  });

  it('falls back to "project" for emoji-only input', () => {
    expect(slugify('🌍🚀✨')).toBe('project');
  });

  it('clamps length to 50', () => {
    const out = slugify('a'.repeat(120));
    expect(out.length).toBeLessThanOrEqual(50);
  });
});

describe('dedupedSlug', () => {
  it('returns base when free', () => {
    expect(dedupedSlug('my-app', [])).toBe('my-app');
    expect(dedupedSlug('my-app', ['other'])).toBe('my-app');
  });

  it('appends -2 on first collision', () => {
    expect(dedupedSlug('my-app', ['my-app'])).toBe('my-app-2');
  });

  it('finds next free index across a sequence', () => {
    expect(dedupedSlug('my-app', ['my-app', 'my-app-2'])).toBe('my-app-3');
  });

  it('skips gaps', () => {
    expect(dedupedSlug('my-app', ['my-app', 'my-app-2', 'my-app-3', 'my-app-5'])).toBe('my-app-4');
  });
});

describe('containerAppName', () => {
  it('joins login and slug', () => {
    expect(containerAppName('octocat', 'hello')).toBe('octocat-hello');
  });

  it('lowercases input', () => {
    expect(containerAppName('Octocat', 'Hello')).toBe('octocat-hello');
  });

  it('matches the valid pattern for short names', () => {
    expect(CONTAINER_APP_PATTERN.test(containerAppName('octo', 'app'))).toBe(true);
  });

  it('clamps length to 32 and stays valid', () => {
    const name = containerAppName('verylonggithublogin', 'super-long-project-slug-name-here');
    expect(name.length).toBeLessThanOrEqual(32);
    expect(CONTAINER_APP_PATTERN.test(name)).toBe(true);
  });

  it('produces stable hash suffix for the same input', () => {
    const a = containerAppName('verylonggithublogin', 'super-long-project-slug-name-here');
    const b = containerAppName('verylonggithublogin', 'super-long-project-slug-name-here');
    expect(a).toBe(b);
  });

  it('produces different suffix for different long inputs', () => {
    const a = containerAppName('verylonggithublogin', 'super-long-project-slug-name-here');
    const b = containerAppName('verylonggithublogin', 'super-long-project-slug-name-other');
    expect(a).not.toBe(b);
  });

  it('replaces invalid chars with -', () => {
    const name = containerAppName('user_name', 'slug.with.dots');
    expect(CONTAINER_APP_PATTERN.test(name)).toBe(true);
  });

  it('never starts with -', () => {
    const name = containerAppName('-leading', 'slug');
    expect(/^[a-z0-9]/.test(name)).toBe(true);
  });

  it('never ends with -', () => {
    const name = containerAppName('user', 'trailing-');
    expect(/[a-z0-9]$/.test(name)).toBe(true);
  });
});
