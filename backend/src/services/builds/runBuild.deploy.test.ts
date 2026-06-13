// H2 — partial-deploy reconcile. Exercises runBuild's deploy step (stub mode, so
// no docker daemon / kaniko) to prove that a P2002 active-deployment race does
// NOT mark a genuinely-deployed build FAILED: Azure has already rolled to the
// image, so the build succeeded — we reconcile the DB instead of failing it.
// Non-P2002 errors must still propagate to runBuild's FAILED catch.
process.env.NODE_ENV = 'test';
process.env.WEB_ORIGIN = 'http://localhost:5173';
process.env.PUBLIC_API_URL = 'http://localhost:3000';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.JWT_SECRET = 'test-jwt-secret-test-jwt-secret-test-jwt-secret';
process.env.COOKIE_SECRET = 'test-cookie-secret-test-cookie-secret-test-cookie';
process.env.DATA_ENC_KEY = Buffer.alloc(32, 9).toString('base64');
process.env.GITHUB_OAUTH_CLIENT_ID = 'test-client-id';
process.env.GITHUB_OAUTH_CLIENT_SECRET = 'test-client-secret';
process.env.GITHUB_OAUTH_CALLBACK_URL = 'http://localhost:3000/api/auth/github/callback';
process.env.AZURE_STUB = 'true';
process.env.LOG_LEVEL = 'silent';
process.env.BUILD_RUNNER_MODE = 'stub';
process.env.BUILD_WORK_DIR = '/tmp/prodstack-builds-test';

import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  buildFindUniqueOrThrow: vi.fn(),
  buildFindUnique: vi.fn(),
  buildUpdate: vi.fn(),
  logLineCreate: vi.fn(),
  deploymentUpdateMany: vi.fn(),
  deploymentCreate: vi.fn(),
  projectUpdate: vi.fn(),
  $transaction: vi.fn(),
  updateContainerApp: vi.fn(),
  loadDecryptedEnvVars: vi.fn(),
}));

vi.mock('../../db.js', () => ({
  prisma: {
    build: {
      findUniqueOrThrow: mocks.buildFindUniqueOrThrow,
      findUnique: mocks.buildFindUnique,
      update: mocks.buildUpdate,
    },
    logLine: { create: mocks.logLineCreate },
    deployment: { updateMany: mocks.deploymentUpdateMany, create: mocks.deploymentCreate },
    project: { update: mocks.projectUpdate },
    $transaction: mocks.$transaction,
  },
}));

vi.mock('../azure/index.js', () => ({ updateContainerApp: mocks.updateContainerApp }));
vi.mock('../projectEnv.js', () => ({ loadDecryptedEnvVars: mocks.loadDecryptedEnvVars }));

const { runBuild } = await import('./runBuild.js');

function stubBuildRow(over: Record<string, unknown> = {}) {
  return {
    id: 'build-1',
    projectId: 'project-1',
    commitSha: 'abc1234def5678',
    branch: 'main',
    startedAt: new Date('2026-06-13T00:00:00Z'),
    project: {
      id: 'project-1',
      containerAppName: 'octocat-app',
      githubRepoFullName: 'octocat/app',
      user: {},
    },
    ...over,
  };
}

/** All `status` values written via `prisma.build.update`, in call order. */
function statusWrites(): string[] {
  return mocks.buildUpdate.mock.calls
    .map((c) => (c[0] as { data?: { status?: string } }).data?.status)
    .filter((s): s is string => typeof s === 'string');
}

/** A Prisma "unique constraint failed" error, as the partial-unique index throws. */
function p2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: 'one_active_per_project' },
  });
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.buildFindUniqueOrThrow.mockResolvedValue(stubBuildRow());
  mocks.buildFindUnique.mockResolvedValue({ cancelRequested: false });
  mocks.buildUpdate.mockResolvedValue({});
  mocks.logLineCreate.mockResolvedValue({});
  mocks.loadDecryptedEnvVars.mockResolvedValue([]);
  mocks.updateContainerApp.mockResolvedValue({
    revisionName: 'octocat-app--rev1',
    liveUrl: 'https://octocat-app.example.test',
  });
});

describe('runBuild deploy reconcile (stub mode)', () => {
  it('happy path: records an active deployment + READY build with no conflict', async () => {
    // The deploy tx succeeds normally.
    mocks.$transaction.mockResolvedValue([]);

    await runBuild('build-1');

    const statuses = statusWrites();
    expect(statuses).toContain('READY');
    expect(statuses).not.toContain('FAILED');
    // Azure was rolled exactly once and the deploy tx ran once (no reconcile).
    expect(mocks.updateContainerApp).toHaveBeenCalledTimes(1);
    expect(mocks.$transaction).toHaveBeenCalledTimes(1);

    // The normal path creates an ACTIVE deployment row.
    const ops = mocks.$transaction.mock.calls[0]![0] as unknown[];
    // The array passed to $transaction is a list of prepared prisma promises;
    // assert the create call recorded active=true via the spy.
    expect(ops.length).toBe(4);
    const createCall = mocks.deploymentCreate.mock.calls.at(-1);
    expect(createCall?.[0]).toMatchObject({ data: { active: true } });
  });

  it('P2002 active-slot race: marks the build READY (NOT FAILED) and records a non-active deployment', async () => {
    // First tx (the active-slot write) loses the race → P2002. Second tx
    // (the reconcile) succeeds.
    mocks.$transaction
      .mockRejectedValueOnce(p2002())
      .mockResolvedValueOnce([]);

    await runBuild('build-1');

    const statuses = statusWrites();
    // The build genuinely succeeded — Azure already rolled to the image.
    expect(statuses).toContain('READY');
    expect(statuses).not.toContain('FAILED');
    // Azure was rolled once; the P2002 must NOT retry the Azure roll.
    expect(mocks.updateContainerApp).toHaveBeenCalledTimes(1);
    // Two transactions: the losing active write + the reconcile write.
    expect(mocks.$transaction).toHaveBeenCalledTimes(2);

    // The reconcile records a NON-active historical deployment row for this image.
    const reconcileCreate = mocks.deploymentCreate.mock.calls.at(-1);
    expect(reconcileCreate?.[0]).toMatchObject({ data: { active: false } });
    // It must NOT flip the winner's deployment inactive on the reconcile path:
    // updateMany is only used by the first (failed) attempt, never the reconcile.
    expect(mocks.deploymentUpdateMany).toHaveBeenCalledTimes(1);
    // It must NOT overwrite the winner's liveUrl — project.update only runs in
    // the first (failed) tx, not the reconcile.
    expect(mocks.projectUpdate).toHaveBeenCalledTimes(1);
  });

  it('non-P2002 deploy-tx error STILL propagates → build ends FAILED (regression guard)', async () => {
    // A real DB failure (not a P2002 race) must not be swallowed: the build
    // should still be marked FAILED by runBuild's outer catch.
    mocks.$transaction.mockRejectedValue(new Error('db connection reset'));

    await runBuild('build-1');

    const statuses = statusWrites();
    // FAILED must be the terminal write. (The READY build.update is *prepared*
    // inside the rejecting $transaction array — recorded by the prisma mock spy —
    // but never commits in real Prisma; the outer catch then writes FAILED via
    // setStatus. The contract is the LAST status the runner records.)
    expect(statuses.at(-1)).toBe('FAILED');
    // Only the single failed deploy tx ran — no reconcile for a non-P2002 error.
    expect(mocks.$transaction).toHaveBeenCalledTimes(1);
    // Azure was still rolled (the failure is purely on the DB-write side).
    expect(mocks.updateContainerApp).toHaveBeenCalledTimes(1);
  });
});
