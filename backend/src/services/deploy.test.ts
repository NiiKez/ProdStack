process.env.NODE_ENV = 'test';
process.env.DATA_ENC_KEY ??= Buffer.alloc(32, 9).toString('base64');
process.env.JWT_SECRET ??= 'x'.repeat(40);
process.env.COOKIE_SECRET ??= 'y'.repeat(40);
process.env.WEB_ORIGIN ??= 'http://localhost:5173';
process.env.GITHUB_OAUTH_CLIENT_ID ??= 'cid';
process.env.GITHUB_OAUTH_CLIENT_SECRET ??= 'csecret';
process.env.GITHUB_OAUTH_CALLBACK_URL ??= 'http://localhost:3000/api/auth/github/callback';
process.env.DATABASE_URL ??= 'postgresql://test/test';
process.env.LOG_LEVEL ??= 'silent';
process.env.AZURE_STUB = 'true';

import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  deploymentFindFirst: vi.fn(),
  buildFindFirst: vi.fn(),
  txDeploymentUpdateMany: vi.fn(),
  txDeploymentCreate: vi.fn(),
  txProjectUpdate: vi.fn(),
  $transaction: vi.fn(),
  updateContainerApp: vi.fn(),
  loadDecryptedEnvVars: vi.fn(),
}));

vi.mock('../db.js', () => ({
  prisma: {
    deployment: { findFirst: mocks.deploymentFindFirst },
    build: { findFirst: mocks.buildFindFirst },
    $transaction: mocks.$transaction,
  },
}));

vi.mock('./azure/index.js', () => ({ updateContainerApp: mocks.updateContainerApp }));
vi.mock('./projectEnv.js', () => ({ loadDecryptedEnvVars: mocks.loadDecryptedEnvVars }));

const { rollbackToDeployment, redeployWithCurrentEnv } = await import('./deploy.js');

const ARGS = { projectId: 'p1', deploymentId: 'd1', userId: 'u1' };

function targetRow(over: Record<string, unknown> = {}) {
  return {
    id: 'd1',
    projectId: 'p1',
    buildId: 'b1',
    revisionName: 'app--rev1',
    active: false,
    rolledBack: false,
    build: { id: 'b1', status: 'READY', imageTag: 'prodstack.azurecr.io/app:sha', ...((over.build as object) ?? {}) },
    project: {
      id: 'p1',
      userId: 'u1',
      containerAppName: 'octocat-app',
      deletedAt: null,
      user: { isDemo: false },
    },
    ...over,
  };
}

async function expectHttp(promise: Promise<unknown>, status: number, code: string) {
  await expect(promise).rejects.toMatchObject({ status, code });
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.buildFindFirst.mockResolvedValue(null); // no in-flight build by default
  mocks.loadDecryptedEnvVars.mockResolvedValue([]);
  mocks.updateContainerApp.mockResolvedValue({
    name: 'octocat-app',
    liveUrl: 'https://octocat-app.example.io',
    revisionName: 'app--rev2',
  });
  mocks.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
    cb({
      deployment: { updateMany: mocks.txDeploymentUpdateMany, create: mocks.txDeploymentCreate },
      project: { update: mocks.txProjectUpdate },
    }),
  );
  mocks.txDeploymentCreate.mockResolvedValue({ id: 'd2', active: true, rolledBack: true, build: {} });
});

describe('rollbackToDeployment', () => {
  it('404s an unknown/foreign deployment', async () => {
    mocks.deploymentFindFirst.mockResolvedValue(null);
    await expectHttp(rollbackToDeployment(ARGS), 404, 'DEPLOYMENT_NOT_FOUND');
    expect(mocks.updateContainerApp).not.toHaveBeenCalled();
  });

  it('409s when the target is already active', async () => {
    mocks.deploymentFindFirst.mockResolvedValue(targetRow({ active: true }));
    await expectHttp(rollbackToDeployment(ARGS), 409, 'ALREADY_ACTIVE');
    expect(mocks.updateContainerApp).not.toHaveBeenCalled();
  });

  it('fails closed for a demo-owned project before any Azure call (defense-in-depth)', async () => {
    mocks.deploymentFindFirst.mockResolvedValue(
      targetRow({
        project: {
          id: 'p1',
          userId: 'u1',
          containerAppName: 'demo-app',
          deletedAt: null,
          user: { isDemo: true },
        },
      }),
    );
    await expectHttp(rollbackToDeployment(ARGS), 403, 'DEMO_NOT_SUPPORTED');
    expect(mocks.updateContainerApp).not.toHaveBeenCalled();
  });

  it('409s when the target build did not finish successfully', async () => {
    mocks.deploymentFindFirst.mockResolvedValue(
      targetRow({ build: { id: 'b1', status: 'FAILED', imageTag: 'app:sha' } }),
    );
    await expectHttp(rollbackToDeployment(ARGS), 409, 'BUILD_NOT_DEPLOYABLE');
    expect(mocks.updateContainerApp).not.toHaveBeenCalled();
  });

  it('409s when the target build never produced an image', async () => {
    mocks.deploymentFindFirst.mockResolvedValue(
      targetRow({ build: { id: 'b1', status: 'READY', imageTag: null } }),
    );
    await expectHttp(rollbackToDeployment(ARGS), 409, 'NO_IMAGE_FOR_BUILD');
    expect(mocks.updateContainerApp).not.toHaveBeenCalled();
  });

  it('409s when a build is in flight for the project', async () => {
    mocks.deploymentFindFirst.mockResolvedValue(targetRow());
    mocks.buildFindFirst.mockResolvedValue({ id: 'b2' });
    await expectHttp(rollbackToDeployment(ARGS), 409, 'BUILD_IN_PROGRESS');
    expect(mocks.updateContainerApp).not.toHaveBeenCalled();
  });

  it('rolls the image, deactivates the previous active row, and writes a rolledBack deployment', async () => {
    mocks.deploymentFindFirst.mockResolvedValue(targetRow());
    await rollbackToDeployment(ARGS);

    expect(mocks.updateContainerApp).toHaveBeenCalledWith({
      name: 'octocat-app',
      image: 'prodstack.azurecr.io/app:sha',
      envVars: [],
    });
    expect(mocks.txDeploymentUpdateMany).toHaveBeenCalledWith({
      where: { projectId: 'p1', active: true },
      data: { active: false },
    });
    const created = mocks.txDeploymentCreate.mock.calls[0]![0]!;
    expect(created.data).toMatchObject({ buildId: 'b1', active: true, rolledBack: true });
  });

  it('maps the one_active_per_project unique violation to a 409 conflict', async () => {
    mocks.deploymentFindFirst.mockResolvedValue(targetRow());
    mocks.txDeploymentCreate.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    await expectHttp(rollbackToDeployment(ARGS), 409, 'ROLLBACK_CONFLICT');
  });
});

describe('redeployWithCurrentEnv', () => {
  const RD_ARGS = { projectId: 'p1', userId: 'u1' };

  // The active deployment is the same shape as `targetRow` but `active: true`.
  function activeRow(over: Record<string, unknown> = {}) {
    return targetRow({ active: true, ...over });
  }

  it('returns NO_ACTIVE_DEPLOYMENT when there is no active deployment', async () => {
    mocks.deploymentFindFirst.mockResolvedValue(null);
    const result = await redeployWithCurrentEnv(RD_ARGS);
    expect(result).toEqual({ redeployed: false, reason: 'NO_ACTIVE_DEPLOYMENT' });
    expect(mocks.updateContainerApp).not.toHaveBeenCalled();
  });

  it('fails closed for a demo-owned project before any Azure call (defense-in-depth)', async () => {
    mocks.deploymentFindFirst.mockResolvedValue(
      activeRow({
        project: {
          id: 'p1',
          userId: 'u1',
          containerAppName: 'demo-app',
          deletedAt: null,
          user: { isDemo: true },
        },
      }),
    );
    await expectHttp(redeployWithCurrentEnv(RD_ARGS), 403, 'DEMO_NOT_SUPPORTED');
    expect(mocks.updateContainerApp).not.toHaveBeenCalled();
  });

  it('returns NO_IMAGE when the active build is not READY', async () => {
    mocks.deploymentFindFirst.mockResolvedValue(
      activeRow({ build: { id: 'b1', status: 'FAILED', imageTag: 'app:sha' } }),
    );
    const result = await redeployWithCurrentEnv(RD_ARGS);
    expect(result).toEqual({ redeployed: false, reason: 'NO_IMAGE' });
    expect(mocks.updateContainerApp).not.toHaveBeenCalled();
  });

  it('returns NO_IMAGE when the active build has a null imageTag', async () => {
    mocks.deploymentFindFirst.mockResolvedValue(
      activeRow({ build: { id: 'b1', status: 'READY', imageTag: null } }),
    );
    const result = await redeployWithCurrentEnv(RD_ARGS);
    expect(result).toEqual({ redeployed: false, reason: 'NO_IMAGE' });
    expect(mocks.updateContainerApp).not.toHaveBeenCalled();
  });

  it('returns BUILD_IN_PROGRESS without rolling when a build is in flight', async () => {
    mocks.deploymentFindFirst.mockResolvedValue(activeRow());
    mocks.buildFindFirst.mockResolvedValue({ id: 'b2' });
    const result = await redeployWithCurrentEnv(RD_ARGS);
    expect(result).toEqual({ redeployed: false, reason: 'BUILD_IN_PROGRESS' });
    expect(mocks.updateContainerApp).not.toHaveBeenCalled();
  });

  it('rolls the active image with the current env vars and writes a non-rolledBack deployment', async () => {
    mocks.deploymentFindFirst.mockResolvedValue(activeRow());
    mocks.loadDecryptedEnvVars.mockResolvedValue([{ name: 'API_KEY', value: 'secret' }]);
    mocks.txDeploymentCreate.mockResolvedValue({
      id: 'd2',
      active: true,
      rolledBack: false,
      build: {},
    });

    const result = await redeployWithCurrentEnv(RD_ARGS);

    expect(result.redeployed).toBe(true);
    expect(result.deployment).toMatchObject({ id: 'd2', active: true, rolledBack: false });
    // forceNewRevision is essential: a value-only env change leaves the ACA
    // template identical, so without it the roll no-ops and the running replica
    // keeps the stale value (the exact "save didn't take effect" bug).
    expect(mocks.updateContainerApp).toHaveBeenCalledWith({
      name: 'octocat-app',
      image: 'prodstack.azurecr.io/app:sha',
      envVars: [{ name: 'API_KEY', value: 'secret' }],
      forceNewRevision: true,
    });
    expect(mocks.txDeploymentUpdateMany).toHaveBeenCalledWith({
      where: { projectId: 'p1', active: true },
      data: { active: false },
    });
    const created = mocks.txDeploymentCreate.mock.calls[0]![0]!;
    expect(created.data).toMatchObject({ buildId: 'b1', active: true, rolledBack: false });
  });

  it('maps the one_active_per_project unique violation to a 409 conflict', async () => {
    mocks.deploymentFindFirst.mockResolvedValue(activeRow());
    mocks.txDeploymentCreate.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    await expectHttp(redeployWithCurrentEnv(RD_ARGS), 409, 'ROLLBACK_CONFLICT');
  });
});
