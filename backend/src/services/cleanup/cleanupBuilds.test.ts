// Cleanup retention is read from env at module load, so the retention values
// must be set BEFORE importing the module under test (same env-before-import
// pattern as routes/admin.test.ts).
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
process.env.RETENTION_DAYS_LOGS = '30';
process.env.RETENTION_DAYS_BUILDS = '90';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  logLineDeleteMany: vi.fn(),
  buildDeleteMany: vi.fn(),
}));

vi.mock('../../db.js', () => ({
  prisma: {
    logLine: { deleteMany: mocks.logLineDeleteMany },
    build: { deleteMany: mocks.buildDeleteMany },
  },
}));

const { cleanupBuilds } = await import('./cleanupBuilds.js');

const DAY_MS = 24 * 60 * 60 * 1000;

describe('cleanupBuilds', () => {
  beforeEach(() => {
    mocks.logLineDeleteMany.mockReset().mockResolvedValue({ count: 12 });
    mocks.buildDeleteMany.mockReset().mockResolvedValue({ count: 3 });
  });
  afterEach(() => vi.clearAllMocks());

  it('deletes log lines older than RETENTION_DAYS_LOGS by ts', async () => {
    const before = Date.now();
    await cleanupBuilds();
    const after = Date.now();

    expect(mocks.logLineDeleteMany).toHaveBeenCalledTimes(1);
    const arg = mocks.logLineDeleteMany.mock.calls[0][0];
    const cutoff = arg.where.ts.lt as Date;
    expect(cutoff).toBeInstanceOf(Date);
    // 30-day window: cutoff is ~now - 30d.
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(before - 30 * DAY_MS - 5);
    expect(cutoff.getTime()).toBeLessThanOrEqual(after - 30 * DAY_MS + 5);
  });

  it('deletes only TERMINAL builds older than RETENTION_DAYS_BUILDS by createdAt', async () => {
    const before = Date.now();
    await cleanupBuilds();
    const after = Date.now();

    expect(mocks.buildDeleteMany).toHaveBeenCalledTimes(1);
    const arg = mocks.buildDeleteMany.mock.calls[0][0];
    expect(arg.where.status.in).toEqual(['READY', 'FAILED', 'CANCELLED']);
    const cutoff = arg.where.createdAt.lt as Date;
    // 90-day window.
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(before - 90 * DAY_MS - 5);
    expect(cutoff.getTime()).toBeLessThanOrEqual(after - 90 * DAY_MS + 5);
  });

  it('does NOT include in-flight statuses in the build delete filter', async () => {
    await cleanupBuilds();
    const arg = mocks.buildDeleteMany.mock.calls[0][0];
    for (const inflight of ['QUEUED', 'CLONING', 'BUILDING', 'PUSHING', 'DEPLOYING']) {
      expect(arg.where.status.in).not.toContain(inflight);
    }
  });

  it('never reaps a build that still backs any Deployment (data-loss guard)', async () => {
    // Critical: Deployment.build is onDelete:Cascade, so deleting a >90d
    // terminal build that is a project's ACTIVE deployment would cascade-delete
    // the live Deployment row. The filter must exclude any referenced build.
    await cleanupBuilds();
    const arg = mocks.buildDeleteMany.mock.calls[0][0];
    expect(arg.where.deployments).toEqual({ none: {} });
  });

  it('never reaps a build that backs an OPEN preview (no Deployment row protects it)', async () => {
    // Preview builds create NO Deployment, so the `deployments:{none:{}}` guard
    // doesn't cover them. An OPEN preview's lastBuildId / log history must survive
    // pruning (Build.previewId is SetNull — no cascade protects it). The filter
    // keeps non-preview builds + torn-down-preview builds prunable.
    await cleanupBuilds();
    const arg = mocks.buildDeleteMany.mock.calls[0][0];
    expect(arg.where.OR).toEqual([
      { previewId: null },
      { preview: { closedAt: { not: null } } },
    ]);
  });

  it('returns the counts reported by Prisma', async () => {
    mocks.logLineDeleteMany.mockResolvedValue({ count: 100 });
    mocks.buildDeleteMany.mockResolvedValue({ count: 7 });
    const res = await cleanupBuilds();
    expect(res).toEqual({ logLinesDeleted: 100, buildsDeleted: 7 });
  });
});
