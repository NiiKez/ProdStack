// Env must be set before importing the module under test (env.ts validates at
// module load). Mirrors the env-before-import pattern in cleanupBuilds.test.ts.
process.env.NODE_ENV = 'test';
process.env.WEB_ORIGIN = 'http://localhost:5173';
process.env.PUBLIC_API_URL = 'http://localhost:3000';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.JWT_SECRET = 'test-jwt-secret-test-jwt-secret-0123456789';
process.env.COOKIE_SECRET = 'test-cookie-secret-0123456789-abcdefghij';
process.env.DATA_ENC_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.GITHUB_OAUTH_CLIENT_ID = 'test-client-id';
process.env.GITHUB_OAUTH_CLIENT_SECRET = 'test-client-secret';
process.env.GITHUB_OAUTH_CALLBACK_URL = 'http://localhost:3000/api/auth/github/callback';
process.env.AZURE_STUB = 'true';
process.env.LOG_LEVEL = 'silent';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  userDeleteMany: vi.fn(),
}));

vi.mock('../../db.js', () => ({
  prisma: {
    user: { deleteMany: mocks.userDeleteMany },
  },
}));

const { cleanupDemo } = await import('./cleanupDemo.js');

describe('cleanupDemo', () => {
  beforeEach(() => {
    mocks.userDeleteMany.mockReset().mockResolvedValue({ count: 4 });
  });
  afterEach(() => vi.clearAllMocks());

  it('deletes only expired demo users (isDemo + demoExpiresAt < now)', async () => {
    const before = Date.now();
    await cleanupDemo();
    const after = Date.now();

    expect(mocks.userDeleteMany).toHaveBeenCalledTimes(1);
    const arg = mocks.userDeleteMany.mock.calls[0][0];
    // Only demo users — never a real user (isDemo defaults false on real rows).
    expect(arg.where.isDemo).toBe(true);
    // Expiry predicate is a Date roughly equal to "now".
    const cutoff = arg.where.demoExpiresAt.lt as Date;
    expect(cutoff).toBeInstanceOf(Date);
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(before - 5);
    expect(cutoff.getTime()).toBeLessThanOrEqual(after + 5);
  });

  it('does NOT match non-demo users (the where clause is the guard)', async () => {
    await cleanupDemo();
    const arg = mocks.userDeleteMany.mock.calls[0][0];
    // A real user (isDemo=false) and a non-expired demo user (demoExpiresAt >= now)
    // both fall outside this filter — there is no broader OR / unconditional delete.
    expect(arg.where).toEqual({ isDemo: true, demoExpiresAt: { lt: expect.any(Date) } });
    expect(Object.keys(arg.where).sort()).toEqual(['demoExpiresAt', 'isDemo']);
  });

  it('returns the demoUsersDeleted count reported by Prisma', async () => {
    mocks.userDeleteMany.mockResolvedValue({ count: 17 });
    const res = await cleanupDemo();
    expect(res).toEqual({ demoUsersDeleted: 17 });
  });
});
