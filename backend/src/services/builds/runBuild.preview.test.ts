// Preview build path: a build with `previewId` set deploys to the ephemeral
// per-PR Container App via createContainerApp (min=0/max=1), marks the
// PreviewEnvironment ACTIVE, and must NOT create a Deployment row or touch
// Project.liveUrl. Stub mode (no docker/kaniko). Mirrors runBuild.deploy.test.ts.
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

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  buildFindUniqueOrThrow: vi.fn(),
  buildFindUnique: vi.fn(),
  buildUpdate: vi.fn(),
  buildUpdateMany: vi.fn(),
  logLineCreate: vi.fn(),
  deploymentCreate: vi.fn(),
  deploymentUpdateMany: vi.fn(),
  projectUpdate: vi.fn(),
  previewFindUnique: vi.fn(),
  previewUpdate: vi.fn(),
  previewUpdateMany: vi.fn(),
  $transaction: vi.fn(),
  createContainerApp: vi.fn(),
  updateContainerApp: vi.fn(),
  deleteContainerApp: vi.fn(),
  loadDecryptedEnvVars: vi.fn(),
}));

vi.mock('../../db.js', () => ({
  prisma: {
    build: {
      findUniqueOrThrow: mocks.buildFindUniqueOrThrow,
      findUnique: mocks.buildFindUnique,
      update: mocks.buildUpdate,
      updateMany: mocks.buildUpdateMany,
    },
    logLine: { create: mocks.logLineCreate },
    deployment: { create: mocks.deploymentCreate, updateMany: mocks.deploymentUpdateMany },
    project: { update: mocks.projectUpdate },
    previewEnvironment: {
      findUnique: mocks.previewFindUnique,
      update: mocks.previewUpdate,
      updateMany: mocks.previewUpdateMany,
    },
    $transaction: mocks.$transaction,
  },
}));

vi.mock('../azure/index.js', () => ({
  createContainerApp: mocks.createContainerApp,
  updateContainerApp: mocks.updateContainerApp,
  deleteContainerApp: mocks.deleteContainerApp,
}));
vi.mock('../projectEnv.js', () => ({ loadDecryptedEnvVars: mocks.loadDecryptedEnvVars }));

const { runBuild } = await import('./runBuild.js');

function previewBuildRow(over: Record<string, unknown> = {}) {
  return {
    id: 'build-1',
    projectId: 'project-1',
    commitSha: 'abc1234def5678',
    branch: 'feature-x',
    previewId: 'pv1',
    startedAt: new Date('2026-06-17T00:00:00Z'),
    project: { id: 'project-1', containerAppName: 'octocat-app', githubRepoFullName: 'octocat/app', user: {} },
    ...over,
  };
}

function statusWrites(): string[] {
  return mocks.buildUpdate.mock.calls
    .map((c) => (c[0] as { data?: { status?: string } }).data?.status)
    .filter((s): s is string => typeof s === 'string');
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.buildFindUniqueOrThrow.mockResolvedValue(previewBuildRow());
  mocks.buildFindUnique.mockResolvedValue({ cancelRequested: false });
  mocks.buildUpdate.mockResolvedValue({});
  mocks.buildUpdateMany.mockResolvedValue({ count: 0 });
  mocks.logLineCreate.mockResolvedValue({});
  mocks.loadDecryptedEnvVars.mockResolvedValue([]);
  // The ACTIVE write is a conditional `previewEnvironment.updateMany` batched with
  // the build update; the $transaction result's [0].count tells the deploy path
  // whether the row was still open (1) or closed mid-deploy (0).
  mocks.$transaction.mockResolvedValue([{ count: 1 }]);
  mocks.previewFindUnique.mockResolvedValue({
    id: 'pv1',
    prNumber: 7,
    containerAppName: 'pr7-abcd1234',
    status: 'PENDING',
    closedAt: null,
  });
  mocks.previewUpdate.mockResolvedValue({});
  mocks.previewUpdateMany.mockResolvedValue({ count: 1 });
  mocks.createContainerApp.mockResolvedValue({
    revisionName: 'pr7-abcd1234--rev1',
    liveUrl: 'https://pr7-abcd1234.example.test',
  });
  mocks.deleteContainerApp.mockResolvedValue(undefined);
});

describe('runBuild — preview (PR) deploy branch (stub mode)', () => {
  it('deploys to the preview app via createContainerApp (min=0/max=1) and marks it ACTIVE', async () => {
    await runBuild('build-1');

    expect(statusWrites()).toContain('READY');
    expect(statusWrites()).not.toContain('FAILED');

    // Deployed to the PREVIEW app name, not the project's main app, scale-to-zero.
    expect(mocks.createContainerApp).toHaveBeenCalledTimes(1);
    const createArg = mocks.createContainerApp.mock.calls[0]![0];
    expect(createArg).toMatchObject({ name: 'pr7-abcd1234', minReplicas: 0, maxReplicas: 1 });
    // The main-app roll path is NOT used for a preview.
    expect(mocks.updateContainerApp).not.toHaveBeenCalled();

    // The PreviewEnvironment row is flipped ACTIVE with the live URL + build link,
    // via a conditional compare-and-set guarded on `closedAt IS NULL` so a PR
    // closed mid-deploy can never be resurrected.
    const pvUpdate = mocks.previewUpdateMany.mock.calls.at(-1)![0];
    expect(pvUpdate.where).toEqual({ id: 'pv1', closedAt: null });
    expect(pvUpdate.data).toMatchObject({
      status: 'ACTIVE',
      liveUrl: 'https://pr7-abcd1234.example.test',
      lastBuildId: 'build-1',
    });
    // Still open → the re-created-app cleanup path is NOT taken.
    expect(mocks.deleteContainerApp).not.toHaveBeenCalled();

    // INVARIANT: a preview never creates a Deployment row or rewrites Project.liveUrl.
    expect(mocks.deploymentCreate).not.toHaveBeenCalled();
    expect(mocks.deploymentUpdateMany).not.toHaveBeenCalled();
    expect(mocks.projectUpdate).not.toHaveBeenCalled();
  });

  it('skips the deploy (build still READY) if the PR was closed mid-build', async () => {
    mocks.previewFindUnique.mockResolvedValue({
      id: 'pv1',
      prNumber: 7,
      containerAppName: 'pr7-abcd1234',
      status: 'TORN_DOWN',
      closedAt: new Date(),
    });

    await runBuild('build-1');

    expect(mocks.createContainerApp).not.toHaveBeenCalled();
    expect(statusWrites()).toContain('READY');
    // No app resurrected, no preview row flipped ACTIVE.
    expect(mocks.previewUpdate).not.toHaveBeenCalled();
  });

  it('marks the preview FAILED (if still PENDING) when the build fails', async () => {
    mocks.createContainerApp.mockRejectedValue(new Error('azure boom'));

    await runBuild('build-1');

    expect(statusWrites().at(-1)).toBe('FAILED');
    expect(mocks.previewUpdateMany).toHaveBeenCalledWith({
      where: { id: 'pv1', status: 'PENDING' },
      data: { status: 'FAILED' },
    });
  });

  it('marks the preview FAILED (if still PENDING) when the build is CANCELLED — not left PENDING', async () => {
    // A cancel requested while the build sits in the claim window aborts it; the
    // cancelled FIRST build of a preview must flip it PENDING→FAILED, else the UI
    // polls it as "building" forever.
    mocks.buildFindUnique.mockResolvedValue({ cancelRequested: true });

    await runBuild('build-1');

    expect(statusWrites().at(-1)).toBe('CANCELLED');
    expect(mocks.createContainerApp).not.toHaveBeenCalled();
    expect(mocks.previewUpdateMany).toHaveBeenCalledWith({
      where: { id: 'pv1', status: 'PENDING' },
      data: { status: 'FAILED' },
    });
  });

  it('does NOT mark the build/preview FAILED when Azure deploy succeeds but the DB write throws (orphan reconcile)', async () => {
    // createContainerApp succeeded → the preview app is LIVE. A transient DB
    // failure on the state-recording transaction must not masquerade as a build
    // failure (which would flip the live preview to FAILED). The path reconciles
    // the build to READY + the preview to ACTIVE out of band instead.
    mocks.$transaction.mockRejectedValueOnce(new Error('db boom'));

    await runBuild('build-1');

    expect(mocks.createContainerApp).toHaveBeenCalledTimes(1);
    // Build still terminal-READY (reconciled), never FAILED.
    expect(statusWrites()).toContain('READY');
    expect(statusWrites()).not.toContain('FAILED');
    // Preview reconciled to ACTIVE out of band (conditional updateMany); the
    // FAILED-if-PENDING path was NOT taken, and the live app was NOT torn down.
    const reconcileCall = mocks.previewUpdateMany.mock.calls.at(-1)![0];
    expect(reconcileCall.where).toEqual({ id: 'pv1', closedAt: null });
    expect(reconcileCall.data).toMatchObject({ status: 'ACTIVE' });
    expect(mocks.previewUpdateMany).not.toHaveBeenCalledWith({
      where: { id: 'pv1', status: 'PENDING' },
      data: { status: 'FAILED' },
    });
    expect(mocks.deleteContainerApp).not.toHaveBeenCalled();
  });

  it('tears down the re-created app if the PR closed mid-deploy (conditional write matches 0 rows)', async () => {
    // The preview was open when we read it (closedAt null), but the PR was closed
    // while createContainerApp was in flight: teardown deleted the app + set
    // closedAt, and our idempotent create re-spawned it. The conditional ACTIVE
    // write (closedAt IS NULL) now matches 0 rows → we must delete the re-created
    // app and NOT resurrect the torn-down row.
    mocks.$transaction.mockResolvedValue([{ count: 0 }]);

    await runBuild('build-1');

    // The deploy happened (app re-spawned by the idempotent create)...
    expect(mocks.createContainerApp).toHaveBeenCalledTimes(1);
    // ...and we tore that orphan back down.
    expect(mocks.deleteContainerApp).toHaveBeenCalledWith('pr7-abcd1234');
    // Build is still terminal-READY (the image genuinely built + pushed).
    expect(statusWrites()).toContain('READY');
    expect(statusWrites()).not.toContain('FAILED');
  });

  it('does NOT delete the live app when the reconcile write ALSO throws (state unknown, not a confirmed close)', async () => {
    // A transient DB error on both the main transaction AND the reconcile write
    // leaves the row state unknown. We must NOT treat that as "PR closed" and
    // delete a healthy live preview — only a *successful* 0-row write confirms a
    // close. The TTL reaper is the backstop for the unknown case.
    mocks.$transaction.mockRejectedValueOnce(new Error('db boom'));
    mocks.previewUpdateMany
      // 1st call = the ACTIVE write inside the (rejected) main transaction's array
      // (its value is discarded); 2nd call = the reconcile write, which throws.
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(new Error('db boom 2'));

    await runBuild('build-1');

    expect(mocks.createContainerApp).toHaveBeenCalledTimes(1);
    // The live app is left in place — NOT torn down on a transient error.
    expect(mocks.deleteContainerApp).not.toHaveBeenCalled();
    // Build still reconciled to READY (best-effort), never FAILED.
    expect(statusWrites()).toContain('READY');
    expect(statusWrites()).not.toContain('FAILED');
  });
});
