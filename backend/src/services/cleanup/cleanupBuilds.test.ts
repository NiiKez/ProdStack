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
  // The LogLine prune is an id-chunked loop: each pass reads a page of the
  // oldest eligible ids (findMany) then deletes exactly those ids (deleteMany).
  logLineFindMany: vi.fn(),
  logLineDeleteMany: vi.fn(),
  buildDeleteMany: vi.fn(),
}));

vi.mock('../../db.js', () => ({
  prisma: {
    logLine: { findMany: mocks.logLineFindMany, deleteMany: mocks.logLineDeleteMany },
    build: { deleteMany: mocks.buildDeleteMany },
  },
}));

const { cleanupBuilds } = await import('./cleanupBuilds.js');

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * In-memory fake of the `LogLine` table so we can exercise the real chunked
 * delete loop (findMany page → deleteMany ids → repeat) end-to-end and assert
 * what actually survives, instead of stubbing fixed counts.
 *
 * findMany honours `where.ts.lt`, `orderBy.ts asc`, and `take` (the page size);
 * deleteMany removes the rows named in `where.id.in` and reports the real count.
 */
interface FakeLogRow {
  id: number;
  ts: Date;
}

let logStore: FakeLogRow[] = [];

function seedLogStore(rows: FakeLogRow[]): void {
  logStore = [...rows];
}

function installLogStoreMocks(): void {
  mocks.logLineFindMany.mockImplementation(async (args: { where: { ts: { lt: Date } }; take: number }) => {
    const cutoff = args.where.ts.lt;
    return logStore
      .filter((r) => r.ts < cutoff)
      .sort((a, b) => a.ts.getTime() - b.ts.getTime())
      .slice(0, args.take)
      .map((r) => ({ id: r.id }));
  });
  mocks.logLineDeleteMany.mockImplementation(async (args: { where: { id: { in: number[] } } }) => {
    const ids = new Set(args.where.id.in);
    const before = logStore.length;
    logStore = logStore.filter((r) => !ids.has(r.id));
    return { count: before - logStore.length };
  });
}

describe('cleanupBuilds', () => {
  beforeEach(() => {
    mocks.logLineFindMany.mockReset();
    mocks.logLineDeleteMany.mockReset();
    mocks.buildDeleteMany.mockReset().mockResolvedValue({ count: 3 });
    seedLogStore([]); // empty by default; per-test seeding overrides
    installLogStoreMocks();
  });
  afterEach(() => vi.clearAllMocks());

  it('selects log lines older than RETENTION_DAYS_LOGS by ts (the prune cutoff)', async () => {
    const before = Date.now();
    await cleanupBuilds();
    const after = Date.now();

    // The cutoff now drives findMany (the chunked loop's page query), not the
    // single deleteMany it replaced.
    expect(mocks.logLineFindMany).toHaveBeenCalled();
    const arg = mocks.logLineFindMany.mock.calls[0][0];
    const cutoff = arg.where.ts.lt as Date;
    expect(cutoff).toBeInstanceOf(Date);
    // 30-day window: cutoff is ~now - 30d.
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(before - 30 * DAY_MS - 5);
    expect(cutoff.getTime()).toBeLessThanOrEqual(after - 30 * DAY_MS + 5);
    // Oldest-first paging so a backlog drains from the tail.
    expect(arg.orderBy).toEqual({ ts: 'asc' });
  });

  it('chunks the LogLine delete across MULTIPLE batches and removes every eligible row', async () => {
    const now = Date.now();
    const oldTs = (offsetDays: number) => new Date(now - (30 + offsetDays) * DAY_MS);
    // 23 eligible rows with a batch size of 5 => pages of 5,5,5,5,3.
    const eligible = Array.from({ length: 23 }, (_, i) => ({ id: i + 1, ts: oldTs(i + 1) }));
    seedLogStore(eligible);

    const res = await cleanupBuilds({ logDeleteBatchSize: 5 });

    // All 23 eligible rows gone.
    expect(logStore).toHaveLength(0);
    expect(res.logLinesDeleted).toBe(23);

    // ceil(23/5) = 5 full delete passes (the 5th page is short → loop ends).
    expect(mocks.logLineDeleteMany).toHaveBeenCalledTimes(5);
    const deletedPerBatch = mocks.logLineDeleteMany.mock.calls.map((c) => c[0].where.id.in.length);
    expect(deletedPerBatch).toEqual([5, 5, 5, 5, 3]);
    // Every delete is by id (the chunk), never an unbounded ts range.
    for (const call of mocks.logLineDeleteMany.mock.calls) {
      expect(call[0].where).toHaveProperty('id.in');
      expect(call[0].where).not.toHaveProperty('ts');
    }
  });

  it('preserves LogLine rows newer than the cutoff and counts only the deleted ones', async () => {
    const now = Date.now();
    const old = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, ts: new Date(now - (40 + i) * DAY_MS) }));
    const fresh = Array.from({ length: 4 }, (_, i) => ({ id: 100 + i, ts: new Date(now - (i + 1) * DAY_MS) }));
    seedLogStore([...old, ...fresh]);

    const res = await cleanupBuilds({ logDeleteBatchSize: 5 });

    // Only the 12 old rows removed; the 4 fresh ones survive untouched.
    expect(res.logLinesDeleted).toBe(12);
    expect(logStore.map((r) => r.id).sort((a, b) => a - b)).toEqual([100, 101, 102, 103]);
  });

  it('makes a single page query and no deletes when nothing is eligible', async () => {
    const now = Date.now();
    seedLogStore([{ id: 1, ts: new Date(now - 5 * DAY_MS) }]); // well within retention

    const res = await cleanupBuilds({ logDeleteBatchSize: 5 });

    expect(res.logLinesDeleted).toBe(0);
    expect(mocks.logLineFindMany).toHaveBeenCalledTimes(1);
    expect(mocks.logLineDeleteMany).not.toHaveBeenCalled();
    expect(logStore).toHaveLength(1);
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

  it('returns the summed LogLine batch count and the Build delete count', async () => {
    const now = Date.now();
    seedLogStore(Array.from({ length: 100 }, (_, i) => ({ id: i + 1, ts: new Date(now - (40 + i) * DAY_MS) })));
    mocks.buildDeleteMany.mockResolvedValue({ count: 7 });

    // Batch size of 5 means 100 rows drain over 20 passes; the total must equal 100.
    const res = await cleanupBuilds({ logDeleteBatchSize: 5 });
    expect(res).toEqual({ logLinesDeleted: 100, buildsDeleted: 7 });
  });
});
