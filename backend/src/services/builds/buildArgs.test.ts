import { describe, expect, it } from 'vitest';

import { isBuildTimePublicEnvKey, selectBuildArgs } from './buildArgs.js';

describe('isBuildTimePublicEnvKey', () => {
  it('accepts the framework "public" prefixes', () => {
    expect(isBuildTimePublicEnvKey('NEXT_PUBLIC_SUPABASE_URL')).toBe(true);
    expect(isBuildTimePublicEnvKey('VITE_API_URL')).toBe(true);
    expect(isBuildTimePublicEnvKey('REACT_APP_KEY')).toBe(true);
    expect(isBuildTimePublicEnvKey('GATSBY_X')).toBe(true);
    expect(isBuildTimePublicEnvKey('NUXT_PUBLIC_X')).toBe(true);
    expect(isBuildTimePublicEnvKey('PUBLIC_X')).toBe(true);
  });

  it('rejects runtime secrets (no public prefix)', () => {
    expect(isBuildTimePublicEnvKey('DATABASE_URL')).toBe(false);
    expect(isBuildTimePublicEnvKey('SUPABASE_SERVICE_ROLE_KEY')).toBe(false);
    expect(isBuildTimePublicEnvKey('ADMIN_EMAIL')).toBe(false);
    expect(isBuildTimePublicEnvKey('JWT_SECRET')).toBe(false);
    // The prefix must be at the START — a substring match must not count.
    expect(isBuildTimePublicEnvKey('MY_NEXT_PUBLIC_THING')).toBe(false);
  });
});

describe('selectBuildArgs', () => {
  it('keeps only public-prefixed vars, preserving name + value and order', () => {
    expect(
      selectBuildArgs([
        { name: 'NEXT_PUBLIC_URL', value: 'https://x.supabase.co' },
        { name: 'DATABASE_URL', value: 'postgres://secret' },
        { name: 'VITE_MODE', value: 'prod' },
        { name: 'SUPABASE_SERVICE_ROLE_KEY', value: 'super-secret' },
      ]),
    ).toEqual([
      { name: 'NEXT_PUBLIC_URL', value: 'https://x.supabase.co' },
      { name: 'VITE_MODE', value: 'prod' },
    ]);
  });

  it('returns [] when nothing is public (secrets never become build args)', () => {
    expect(selectBuildArgs([{ name: 'DATABASE_URL', value: 'x' }])).toEqual([]);
    expect(selectBuildArgs([])).toEqual([]);
  });
});
