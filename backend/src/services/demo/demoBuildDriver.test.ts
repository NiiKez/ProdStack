// Demo build replay driver (docs/DEMO_MODE.md §5.2). Asserts the convincing
// trick is DB-only and correct: monotonic seq, status advancing through the
// captured timeline, and a single-winner terminal finalize that creates an
// active Deployment + sets the project's liveUrl — with NO Azure/Kaniko/git call.
process.env.NODE_ENV = 'test';
process.env.WEB_ORIGIN = 'http://localhost:5173';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.JWT_SECRET = 'test-jwt-secret-test-jwt-secret-test-jwt-secret';
process.env.COOKIE_SECRET = 'test-cookie-secret-test-cookie-secret-test-cookie';
process.env.DATA_ENC_KEY = Buffer.alloc(32, 9).toString('base64');
process.env.GITHUB_OAUTH_CLIENT_ID = 'test-client-id';
process.env.GITHUB_OAUTH_CLIENT_SECRET = 'test-client-secret';
process.env.GITHUB_OAUTH_CALLBACK_URL = 'http://localhost:3000/api/auth/github/callback';
process.env.AZURE_STUB = 'true';
process.env.LOG_LEVEL = 'silent';
process.env.DEMO_REPLAY_SPEED = '6';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  buildFindUniqueOrThrow: vi.fn(),
  buildFindMany: vi.fn(),
  buildUpdate: vi.fn(),
  buildUpdateMany: vi.fn(),
  logLineCreate: vi.fn(),
  logLineAggregate: vi.fn(),
  deploymentUpdateMany: vi.fn(),
  deploymentCreate: vi.fn(),
  projectUpdate: vi.fn(),
  $transaction: vi.fn(),
}));

// The interactive-transaction client (`tx`) exposes the same mock fns as the
// top-level prisma mock, so assertions can read calls from either path.
const txClient = {
  build: { updateMany: mocks.buildUpdateMany },
  deployment: { updateMany: mocks.deploymentUpdateMany, create: mocks.deploymentCreate },
  project: { update: mocks.projectUpdate },
};

vi.mock('../../db.js', () => ({
  prisma: {
    $transaction: mocks.$transaction,
    build: {
      findUniqueOrThrow: mocks.buildFindUniqueOrThrow,
      findMany: mocks.buildFindMany,
      update: mocks.buildUpdate,
      updateMany: mocks.buildUpdateMany,
    },
    logLine: { create: mocks.logLineCreate, aggregate: mocks.logLineAggregate },
    deployment: {
      updateMany: mocks.deploymentUpdateMany,
      create: mocks.deploymentCreate,
    },
    project: { update: mocks.projectUpdate },
  },
}));

const { runDemoReplay, recoverDemoBuilds, fixture } = await import('./demoBuildDriver.js');

const PROJECT = {
  id: 'proj-1',
  slug: 'cool-app',
  containerAppName: 'demo-cool-app',
  deletedAt: null,
};

const noSleep = (_ms: number): Promise<void> => Promise.resolve();

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  // Interactive form: run the callback against the tx client. (No array form is
  // used anymore, but support it defensively.)
  mocks.$transaction.mockImplementation(async (arg: unknown) =>
    typeof arg === 'function'
      ? (arg as (tx: typeof txClient) => Promise<unknown>)(txClient)
      : Promise.all(arg as Promise<unknown>[]),
  );
  mocks.buildUpdate.mockResolvedValue({});
  // The conditional finalize flip "wins" by default (count 1).
  mocks.buildUpdateMany.mockResolvedValue({ count: 1 });
  mocks.logLineCreate.mockResolvedValue({});
  mocks.logLineAggregate.mockResolvedValue({ _max: { seq: null } });
  mocks.deploymentUpdateMany.mockResolvedValue({ count: 0 });
  mocks.deploymentCreate.mockResolvedValue({});
  mocks.projectUpdate.mockResolvedValue({});
});

describe('runDemoReplay', () => {
  beforeEach(() => {
    mocks.buildFindUniqueOrThrow.mockResolvedValue({
      id: 'build-1',
      projectId: PROJECT.id,
      project: PROJECT,
    });
  });

  it('writes log lines with a monotonically increasing seq starting at 1', async () => {
    await runDemoReplay('build-1', { sleep: noSleep });

    const seqs = mocks.logLineCreate.mock.calls.map((c) => c[0].data.seq);
    expect(seqs.length).toBe(fixture.lines.length);
    expect(seqs[0]).toBe(1);
    // strictly increasing by 1
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBe(seqs[i - 1] + 1);
    }
  });

  it('starts seq after any rows already attached to the build (no collision on re-drive)', async () => {
    mocks.logLineAggregate.mockResolvedValue({ _max: { seq: 9 } });
    await runDemoReplay('build-1', { sleep: noSleep });

    const seqs = mocks.logLineCreate.mock.calls.map((c) => c[0].data.seq);
    expect(seqs[0]).toBe(10);
  });

  it('substitutes the project slug into log + liveUrl templates', async () => {
    await runDemoReplay('build-1', { sleep: noSleep });

    const messages = mocks.logLineCreate.mock.calls.map((c) => c[0].data.message as string);
    // No raw {slug} placeholder survives.
    expect(messages.some((m) => m.includes('{slug}'))).toBe(false);
    // The final deploy line carries the substituted slug.
    expect(messages.some((m) => m.includes('cool-app.demo.prodstack.live'))).toBe(true);

    const projUpdate = mocks.projectUpdate.mock.calls.at(-1)![0];
    expect(projUpdate.data.liveUrl).toContain('cool-app.demo.prodstack.live');
    expect(projUpdate.data.frameworkHint).toBe(fixture.framework);
  });

  it('advances Build.status through the captured timeline order (READY set by finalize)', async () => {
    await runDemoReplay('build-1', { sleep: noSleep });

    // Direct build.update only carries the intermediate transitions; QUEUED is
    // excluded (build starts QUEUED) and READY is the finalize's conditional flip.
    const statuses = mocks.buildUpdate.mock.calls
      .map((c) => c[0].data.status)
      .filter((s): s is string => typeof s === 'string');
    expect(statuses).toEqual(['CLONING', 'BUILDING', 'PUSHING', 'DEPLOYING']);
  });

  it('finalizes with a single-winner transaction: READY flip + active deployment + liveUrl', async () => {
    await runDemoReplay('build-1', { sleep: noSleep });

    expect(mocks.$transaction).toHaveBeenCalledTimes(1);

    // Conditional READY flip never clobbers a terminal state.
    const flip = mocks.buildUpdateMany.mock.calls
      .map((c) => c[0])
      .find((u) => u.data.status === 'READY')!;
    expect(flip.where).toMatchObject({ id: 'build-1' });
    expect(flip.where.status.notIn).toEqual(['READY', 'FAILED', 'CANCELLED']);
    expect(flip.data.imageTag).toBe(fixture.imageTag);
    expect(flip.data.finishedAt).toBeInstanceOf(Date);
    expect(typeof flip.data.durationMs).toBe('number');

    // Prior active deployment deactivated, fresh active one created.
    expect(mocks.deploymentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId: PROJECT.id, active: true },
        data: { active: false },
      }),
    );
    const depCreate = mocks.deploymentCreate.mock.calls.at(-1)![0];
    expect(depCreate.data).toMatchObject({ projectId: PROJECT.id, buildId: 'build-1', active: true });
    expect(depCreate.data.revisionName).toContain('demo-');
  });

  it('skips the active-deployment write when another writer already finalized (flip count 0)', async () => {
    mocks.buildUpdateMany.mockResolvedValue({ count: 0 });
    await runDemoReplay('build-1', { sleep: noSleep });

    expect(mocks.$transaction).toHaveBeenCalledTimes(1);
    // Lost the flip → never deactivate/create a deployment (no double-active row).
    expect(mocks.deploymentUpdateMany).not.toHaveBeenCalled();
    expect(mocks.deploymentCreate).not.toHaveBeenCalled();
  });

  it('marks the build FAILED (without clobbering terminal state) if the replay throws mid-stream', async () => {
    mocks.logLineCreate.mockRejectedValueOnce(new Error('db blip'));
    await expect(runDemoReplay('build-1', { sleep: noSleep })).rejects.toThrow('db blip');

    const failed = mocks.buildUpdateMany.mock.calls
      .map((c) => c[0])
      .find((u) => u.data.status === 'FAILED')!;
    expect(failed).toBeTruthy();
    expect(failed.where.status.notIn).toEqual(['READY', 'FAILED', 'CANCELLED']);
  });

  it('scales the sleep cadence by DEMO_REPLAY_SPEED (instant when no real delay)', async () => {
    const sleep = vi.fn(noSleep);
    await runDemoReplay('build-1', { sleep });

    // Every requested delay is (deltaMs / 6); none is negative.
    for (const call of sleep.mock.calls) {
      expect(call[0]).toBeGreaterThanOrEqual(0);
    }
    // The first real gap (200ms to the first line) → 200/6 ≈ 33.3ms.
    expect(sleep.mock.calls[0]![0]).toBeCloseTo(200 / 6, 5);
  });
});

describe('recoverDemoBuilds', () => {
  it('fast-forwards only in-flight isDemo builds to READY', async () => {
    mocks.buildFindMany.mockResolvedValue([
      { id: 'b1', projectId: 'p1', startedAt: new Date(Date.now() - 5000), project: { id: 'p1', slug: 's1', containerAppName: 'demo-s1', deletedAt: null } },
      { id: 'b2', projectId: 'p2', startedAt: null, project: { id: 'p2', slug: 's2', containerAppName: 'demo-s2', deletedAt: null } },
    ]);

    const n = await recoverDemoBuilds();
    expect(n).toBe(2);

    // The query is scoped to isDemo=true + in-flight statuses (never real builds).
    const where = mocks.buildFindMany.mock.calls[0]![0].where;
    expect(where.isDemo).toBe(true);
    expect(where.status.in).toEqual(['CLONING', 'BUILDING', 'PUSHING', 'DEPLOYING']);

    // Each stuck build runs the finalize transaction → READY flip.
    expect(mocks.$transaction).toHaveBeenCalledTimes(2);
    const readyStatuses = mocks.buildUpdateMany.mock.calls.map((c) => c[0].data.status);
    expect(readyStatuses.every((s) => s === 'READY')).toBe(true);
  });

  it('does not double-count a build a live replay already finalized (flip count 0)', async () => {
    mocks.buildFindMany.mockResolvedValue([
      { id: 'b1', projectId: 'p1', startedAt: null, project: { id: 'p1', slug: 's1', containerAppName: 'demo-s1', deletedAt: null } },
    ]);
    mocks.buildUpdateMany.mockResolvedValue({ count: 0 });

    const n = await recoverDemoBuilds();
    expect(n).toBe(0);
    expect(mocks.deploymentCreate).not.toHaveBeenCalled();
  });

  it('skips soft-deleted projects and isolates per-build failures', async () => {
    mocks.buildFindMany.mockResolvedValue([
      { id: 'b1', projectId: 'p1', startedAt: null, project: { id: 'p1', slug: 's1', containerAppName: 'demo-s1', deletedAt: new Date() } },
      { id: 'b2', projectId: 'p2', startedAt: null, project: { id: 'p2', slug: 's2', containerAppName: 'demo-s2', deletedAt: null } },
    ]);

    const n = await recoverDemoBuilds();
    // p1 skipped (soft-deleted); only p2 finalized.
    expect(n).toBe(1);
    expect(mocks.$transaction).toHaveBeenCalledTimes(1);
  });

  it('returns 0 and runs no transaction when nothing is in-flight', async () => {
    mocks.buildFindMany.mockResolvedValue([]);
    const n = await recoverDemoBuilds();
    expect(n).toBe(0);
    expect(mocks.$transaction).not.toHaveBeenCalled();
  });
});
