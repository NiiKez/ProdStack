// M5b: manual rebuild endpoint + env-var-save redeploy summary.
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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { encrypt } from '../lib/crypto.js';

const state = vi.hoisted(() => ({ stubAuth: true }));

const mocks = vi.hoisted(() => ({
  projectFindFirst: vi.fn(),
  userFindUnique: vi.fn(),
  buildFindFirst: vi.fn(),
  buildCreate: vi.fn(),
  $transaction: vi.fn(),
  octokitForUser: vi.fn(),
  fetchBranchHeadCommit: vi.fn(),
  redeployWithCurrentEnv: vi.fn(),
  loadDecryptedEnvVars: vi.fn(),
}));

vi.mock('../db.js', () => ({
  prisma: {
    project: { findFirst: mocks.projectFindFirst },
    user: { findUnique: mocks.userFindUnique },
    build: { findFirst: mocks.buildFindFirst, create: mocks.buildCreate },
    $transaction: mocks.$transaction,
  },
}));

// Keep the real GithubWebhookError/GithubCommitError classes so `instanceof`
// resolves; stub only the network-touching factory + commit fetch.
vi.mock('../services/github.js', async () => {
  const actual = (await vi.importActual('../services/github.js')) as Record<string, unknown>;
  return {
    ...actual,
    octokitForUser: mocks.octokitForUser,
    fetchBranchHeadCommit: mocks.fetchBranchHeadCommit,
  };
});

vi.mock('../services/deploy.js', () => ({
  rollbackToDeployment: vi.fn(),
  redeployWithCurrentEnv: mocks.redeployWithCurrentEnv,
  IN_FLIGHT_BUILD_STATUSES: ['QUEUED', 'CLONING', 'BUILDING', 'PUSHING', 'DEPLOYING'],
}));

vi.mock('../services/projectEnv.js', () => ({
  loadDecryptedEnvVars: mocks.loadDecryptedEnvVars,
}));

vi.mock('../services/azure/index.js', () => ({
  createContainerApp: vi.fn(),
  updateContainerApp: vi.fn(),
  deleteContainerApp: vi.fn(),
}));

vi.mock('../middleware/requireAuth.js', () => ({
  requireAuth: (
    req: { user?: unknown },
    res: { status: (n: number) => { json: (b: unknown) => void } },
    next: () => void,
  ) => {
    if (state.stubAuth) {
      req.user = { id: 'u1', githubLogin: 'octocat', email: null, avatarUrl: null };
      next();
      return;
    }
    res.status(401).json({ error: 'UNAUTHORIZED' });
  },
}));

vi.mock('./auth.js', async () => {
  const express = await import('express');
  return { default: express.Router() };
});

const { createApp } = await import('../app.js');
const supertest = (await import('supertest')).default;

const tokenField = encrypt('ghp_dummy_token');
const userRow = {
  id: 'u1',
  githubLogin: 'octocat',
  email: null,
  avatarUrl: null,
  githubTokenCiphertext: tokenField.ciphertext,
  githubTokenIv: tokenField.iv,
  githubTokenAuthTag: tokenField.authTag,
  githubTokenKeyVersion: tokenField.keyVersion,
};

const project = {
  id: 'p1',
  userId: 'u1',
  name: 'Hello',
  slug: 'hello',
  githubRepoFullName: 'octocat/hello',
  githubRepoId: 12345,
  branch: 'main',
  webhookId: 99,
  containerAppName: 'octocat-app',
  liveUrl: 'https://octocat-app.example.com',
  frameworkHint: null,
  createdAt: new Date('2026-05-31T09:00:00Z'),
  updatedAt: new Date('2026-05-31T09:00:00Z'),
  deletedAt: null,
};

beforeEach(() => {
  state.stubAuth = true;
  for (const m of Object.values(mocks)) m.mockReset();

  mocks.projectFindFirst.mockResolvedValue(project);
  mocks.userFindUnique.mockResolvedValue(userRow);
  mocks.buildFindFirst.mockResolvedValue(null); // no in-flight build by default
  mocks.buildCreate.mockResolvedValue({ id: 'newbuild1' });
  mocks.octokitForUser.mockReturnValue({ request: vi.fn() });
  mocks.fetchBranchHeadCommit.mockResolvedValue({
    sha: 'deadbeef',
    message: 'fix things',
    author: 'octocat',
  });
  mocks.loadDecryptedEnvVars.mockResolvedValue([]);
  mocks.redeployWithCurrentEnv.mockResolvedValue({ redeployed: false });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/projects/:id/rebuild', () => {
  it('403 without X-Requested-With', async () => {
    const res = await supertest(createApp()).post('/api/projects/p1/rebuild');
    expect(res.status).toBe(403);
    expect(mocks.buildCreate).not.toHaveBeenCalled();
  });

  it('404 when the project is not owned', async () => {
    mocks.projectFindFirst.mockResolvedValue(null);
    const res = await supertest(createApp())
      .post('/api/projects/p1/rebuild')
      .set('X-Requested-With', 'XMLHttpRequest');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('PROJECT_NOT_FOUND');
  });

  it('409 BUILD_IN_PROGRESS when a build is in flight', async () => {
    mocks.buildFindFirst.mockResolvedValue({ id: 'b-running' });
    const res = await supertest(createApp())
      .post('/api/projects/p1/rebuild')
      .set('X-Requested-With', 'XMLHttpRequest');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('BUILD_IN_PROGRESS');
    expect(mocks.buildCreate).not.toHaveBeenCalled();
  });

  it('202 with buildId on the happy path, queuing a build for the branch head', async () => {
    const res = await supertest(createApp())
      .post('/api/projects/p1/rebuild')
      .set('X-Requested-With', 'XMLHttpRequest');
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ buildId: 'newbuild1' });
    const created = mocks.buildCreate.mock.calls[0]![0]!;
    expect(created.data).toMatchObject({
      projectId: 'p1',
      commitSha: 'deadbeef',
      commitMessage: 'fix things',
      commitAuthor: 'octocat',
      branch: 'main',
      status: 'QUEUED',
    });
  });

  it('falls back to the last build when GitHub fails', async () => {
    mocks.fetchBranchHeadCommit.mockRejectedValue(new Error('github down'));
    // The github branch lookup (first findFirst is the in-flight check returning
    // null) then the last-build fallback findFirst returns a prior build.
    mocks.buildFindFirst
      .mockResolvedValueOnce(null) // in-flight check
      .mockResolvedValueOnce({
        commitSha: 'oldsha',
        commitMessage: 'previous',
        commitAuthor: 'octocat',
      });
    const res = await supertest(createApp())
      .post('/api/projects/p1/rebuild')
      .set('X-Requested-With', 'XMLHttpRequest');
    expect(res.status).toBe(202);
    const created = mocks.buildCreate.mock.calls[0]![0]!;
    expect(created.data).toMatchObject({ commitSha: 'oldsha', commitMessage: 'previous' });
  });

  it('400 NO_COMMIT_AVAILABLE when GitHub fails and there is no prior build', async () => {
    mocks.fetchBranchHeadCommit.mockRejectedValue(new Error('github down'));
    mocks.buildFindFirst
      .mockResolvedValueOnce(null) // in-flight check
      .mockResolvedValueOnce(null); // last-build fallback → none
    const res = await supertest(createApp())
      .post('/api/projects/p1/rebuild')
      .set('X-Requested-With', 'XMLHttpRequest');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('NO_COMMIT_AVAILABLE');
    expect(mocks.buildCreate).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/projects/:id env-var redeploy summary', () => {
  function mockPatchTx() {
    // The handler runs a $transaction(cb) then awaits the env-var write +
    // findFirstOrThrow inside. We only need it to return a reshaped project.
    mocks.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
      cb({
        project: {
          update: vi.fn(),
          findFirstOrThrow: vi.fn().mockResolvedValue({
            ...project,
            builds: [],
            deployments: [],
          }),
        },
        envVar: {
          deleteMany: vi.fn(),
          upsert: vi.fn(),
        },
      }),
    );
  }

  it('reports redeploy.redeployed=true when there is an active READY deployment', async () => {
    mockPatchTx();
    // existing env empty → desired differs → redeploy triggered.
    mocks.loadDecryptedEnvVars.mockResolvedValue([]);
    mocks.redeployWithCurrentEnv.mockResolvedValue({
      redeployed: true,
      deployment: { id: 'd2' },
    });

    const res = await supertest(createApp())
      .patch('/api/projects/p1')
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({ envVars: [{ key: 'API_KEY', value: 'secret' }] });

    expect(res.status).toBe(200);
    expect(res.body.redeploy).toEqual({ redeployed: true });
    expect(mocks.redeployWithCurrentEnv).toHaveBeenCalledWith({
      projectId: 'p1',
      userId: 'u1',
    });
  });

  it('reports reason=NO_ACTIVE_DEPLOYMENT when nothing is live', async () => {
    mockPatchTx();
    mocks.loadDecryptedEnvVars.mockResolvedValue([]);
    mocks.redeployWithCurrentEnv.mockResolvedValue({
      redeployed: false,
      reason: 'NO_ACTIVE_DEPLOYMENT',
    });

    const res = await supertest(createApp())
      .patch('/api/projects/p1')
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({ envVars: [{ key: 'API_KEY', value: 'secret' }] });

    expect(res.status).toBe(200);
    expect(res.body.redeploy).toEqual({ redeployed: false, reason: 'NO_ACTIVE_DEPLOYMENT' });
  });

  it('skips the redeploy (redeployed=false, no reason) when env vars are unchanged', async () => {
    mockPatchTx();
    // existing matches desired → no change → no redeploy call.
    mocks.loadDecryptedEnvVars.mockResolvedValue([{ name: 'API_KEY', value: 'secret' }]);

    const res = await supertest(createApp())
      .patch('/api/projects/p1')
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({ envVars: [{ key: 'API_KEY', value: 'secret' }] });

    expect(res.status).toBe(200);
    expect(res.body.redeploy).toEqual({ redeployed: false });
    expect(mocks.redeployWithCurrentEnv).not.toHaveBeenCalled();
  });

  it('triggers a redeploy when an existing value changes (same key)', async () => {
    mockPatchTx();
    mocks.loadDecryptedEnvVars.mockResolvedValue([{ name: 'API_KEY', value: 'old' }]);
    mocks.redeployWithCurrentEnv.mockResolvedValue({ redeployed: true });

    const res = await supertest(createApp())
      .patch('/api/projects/p1')
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({ envVars: [{ key: 'API_KEY', value: 'new' }] });

    expect(res.status).toBe(200);
    expect(res.body.redeploy).toEqual({ redeployed: true });
    expect(mocks.redeployWithCurrentEnv).toHaveBeenCalled();
  });

  it('triggers a redeploy when a key is removed', async () => {
    mockPatchTx();
    mocks.loadDecryptedEnvVars.mockResolvedValue([
      { name: 'API_KEY', value: 'secret' },
      { name: 'DEBUG', value: '1' },
    ]);
    mocks.redeployWithCurrentEnv.mockResolvedValue({ redeployed: true });

    const res = await supertest(createApp())
      .patch('/api/projects/p1')
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({ envVars: [{ key: 'API_KEY', value: 'secret' }] });

    expect(res.status).toBe(200);
    expect(res.body.redeploy).toEqual({ redeployed: true });
    expect(mocks.redeployWithCurrentEnv).toHaveBeenCalled();
  });

  it('does not redeploy when the same vars are submitted in a different order', async () => {
    mockPatchTx();
    mocks.loadDecryptedEnvVars.mockResolvedValue([
      { name: 'A', value: '1' },
      { name: 'B', value: '2' },
    ]);

    const res = await supertest(createApp())
      .patch('/api/projects/p1')
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({ envVars: [{ key: 'B', value: '2' }, { key: 'A', value: '1' }] });

    expect(res.status).toBe(200);
    expect(res.body.redeploy).toEqual({ redeployed: false });
    expect(mocks.redeployWithCurrentEnv).not.toHaveBeenCalled();
  });

  it('downgrades a redeploy failure to redeploy.reason=REDEPLOY_FAILED without failing the save', async () => {
    mockPatchTx();
    mocks.loadDecryptedEnvVars.mockResolvedValue([]);
    const { HttpError } = await import('../lib/errors.js');
    mocks.redeployWithCurrentEnv.mockRejectedValue(new HttpError(409, 'ROLLBACK_CONFLICT'));

    const res = await supertest(createApp())
      .patch('/api/projects/p1')
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({ envVars: [{ key: 'API_KEY', value: 'secret' }] });

    expect(res.status).toBe(200);
    expect(res.body.redeploy).toEqual({ redeployed: false, reason: 'REDEPLOY_FAILED' });
  });

  it('omits the redeploy summary when envVars is not provided', async () => {
    mockPatchTx();
    const res = await supertest(createApp())
      .patch('/api/projects/p1')
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({ name: 'Renamed' });

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('redeploy');
    expect(mocks.redeployWithCurrentEnv).not.toHaveBeenCalled();
  });
});
