// Preview reaper: tears down open previews past their TTL. Mirrors the
// env-before-import + mocked-db pattern in cleanupDemo.test.ts.
process.env.NODE_ENV = 'test';
process.env.WEB_ORIGIN = 'http://localhost:5173';
process.env.PUBLIC_API_URL = 'http://localhost:3000';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.JWT_SECRET = 'test-jwt-secret-test-jwt-secret-test-jwt-secret';
process.env.COOKIE_SECRET = 'test-cookie-secret-0123456789-abcdefghij';
process.env.DATA_ENC_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.GITHUB_OAUTH_CLIENT_ID = 'test-client-id';
process.env.GITHUB_OAUTH_CLIENT_SECRET = 'test-client-secret';
process.env.GITHUB_OAUTH_CALLBACK_URL = 'http://localhost:3000/api/auth/github/callback';
process.env.AZURE_STUB = 'true';
process.env.LOG_LEVEL = 'silent';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findManyPreviews: vi.fn(),
  teardownPreview: vi.fn(),
}));

vi.mock('../../db.js', () => ({
  prisma: { previewEnvironment: { findMany: mocks.findManyPreviews } },
}));
vi.mock('../previews/previewService.js', () => ({ teardownPreview: mocks.teardownPreview }));

const { cleanupExpiredPreviews } = await import('./cleanupPreviews.js');

beforeEach(() => {
  mocks.findManyPreviews.mockReset().mockResolvedValue([]);
  mocks.teardownPreview.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.clearAllMocks());

describe('cleanupExpiredPreviews', () => {
  it('queries only OPEN previews past their TTL (closedAt null, not TORN_DOWN, expiresAt < now)', async () => {
    const now = new Date('2026-06-17T12:00:00Z');
    await cleanupExpiredPreviews(now);
    const where = mocks.findManyPreviews.mock.calls[0]![0].where;
    expect(where.closedAt).toBeNull();
    expect(where.status).toEqual({ not: 'TORN_DOWN' });
    expect(where.expiresAt).toEqual({ lt: now });
  });

  it('tears down every expired preview and reports the counts', async () => {
    mocks.findManyPreviews.mockResolvedValue([
      { id: 'pv1', prNumber: 1, projectId: 'p1' },
      { id: 'pv2', prNumber: 2, projectId: 'p1' },
    ]);
    const res = await cleanupExpiredPreviews(new Date());
    expect(mocks.teardownPreview).toHaveBeenCalledTimes(2);
    expect(mocks.teardownPreview).toHaveBeenCalledWith('pv1');
    expect(mocks.teardownPreview).toHaveBeenCalledWith('pv2');
    expect(res).toEqual({ scanned: 2, tornDown: 2 });
  });

  it('does nothing when no preview has expired', async () => {
    const res = await cleanupExpiredPreviews(new Date());
    expect(mocks.teardownPreview).not.toHaveBeenCalled();
    expect(res).toEqual({ scanned: 0, tornDown: 0 });
  });

  it('keeps going if one teardown fails (counts only the successes)', async () => {
    mocks.findManyPreviews.mockResolvedValue([
      { id: 'pv1', prNumber: 1, projectId: 'p1' },
      { id: 'pv2', prNumber: 2, projectId: 'p1' },
    ]);
    mocks.teardownPreview.mockRejectedValueOnce(new Error('azure flaky'));
    const res = await cleanupExpiredPreviews(new Date());
    expect(mocks.teardownPreview).toHaveBeenCalledTimes(2);
    expect(res).toEqual({ scanned: 2, tornDown: 1 });
  });
});
