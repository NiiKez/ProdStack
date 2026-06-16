process.env.NODE_ENV = 'test';
process.env.DATA_ENC_KEY ??= Buffer.alloc(32, 9).toString('base64');
process.env.JWT_SECRET ??= 'x'.repeat(40);
process.env.COOKIE_SECRET ??= 'y'.repeat(40);
process.env.WEB_ORIGIN ??= 'http://localhost:5173';
process.env.GITHUB_OAUTH_CLIENT_ID ??= 'cid';
process.env.GITHUB_OAUTH_CLIENT_SECRET ??= 'csecret';
process.env.GITHUB_OAUTH_CALLBACK_URL ??= 'http://localhost:3000/api/auth/github/callback';
process.env.DATABASE_URL ??= 'postgresql://test/test';
process.env.AZURE_STUB ??= 'true';
process.env.LOG_LEVEL ??= 'silent';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { encrypt } from '../lib/crypto.js';

// Focused, self-contained mocks for the Stop/Resume + rebuild-guard routes only
// (the big projects.test.ts in-memory fixture is left untouched).
const tokenField = encrypt('ghp_dummy_token');

const state = vi.hoisted(() => ({ isDemo: false }));

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  projectFindFirst: vi.fn(),
  projectFindUniqueOrThrow: vi.fn(),
  projectUpdate: vi.fn(),
  buildFindFirst: vi.fn(),
  buildCreate: vi.fn(),
  stopContainerApp: vi.fn(),
  startContainerApp: vi.fn(),
  stopDemoProject: vi.fn(),
  resumeDemoProject: vi.fn(),
  octokitForUser: vi.fn(),
  fetchBranchHeadCommit: vi.fn(),
}));

vi.mock('../db.js', () => ({
  prisma: {
    user: { findUnique: mocks.userFindUnique },
    project: {
      findFirst: mocks.projectFindFirst,
      findUniqueOrThrow: mocks.projectFindUniqueOrThrow,
      update: mocks.projectUpdate,
    },
    build: { findFirst: mocks.buildFindFirst, create: mocks.buildCreate },
  },
}));

vi.mock('../services/azure/index.js', () => ({
  createContainerApp: vi.fn(),
  updateContainerApp: vi.fn(),
  deleteContainerApp: vi.fn(),
  stopContainerApp: mocks.stopContainerApp,
  startContainerApp: mocks.startContainerApp,
}));

vi.mock('../services/demo/demoOrchestrator.js', () => ({
  createDemoProject: vi.fn(),
  startDemoBuild: vi.fn(),
  rollbackDemoDeployment: vi.fn(),
  stopDemoProject: mocks.stopDemoProject,
  resumeDemoProject: mocks.resumeDemoProject,
}));

vi.mock('../services/github.js', async () => {
  const actual = (await vi.importActual('../services/github.js')) as Record<string, unknown>;
  return {
    ...actual,
    octokitForUser: mocks.octokitForUser,
    fetchBranchHeadCommit: mocks.fetchBranchHeadCommit,
  };
});

vi.mock('../middleware/requireAuth.js', () => ({
  requireAuth: (
    req: { user?: unknown },
    _res: unknown,
    next: () => void,
  ) => {
    req.user = {
      id: 'u1',
      githubLogin: 'octocat',
      email: 'octo@example.com',
      avatarUrl: null,
      isDemo: state.isDemo,
    };
    next();
  },
}));

vi.mock('./auth.js', async () => {
  const express = await import('express');
  return { default: express.Router() };
});

const { createApp } = await import('../app.js');
const supertest = (await import('supertest')).default;

const userRow = {
  id: 'u1',
  githubLogin: 'octocat',
  email: 'octo@example.com',
  avatarUrl: null,
  githubTokenCiphertext: tokenField.ciphertext,
  githubTokenIv: tokenField.iv,
  githubTokenAuthTag: tokenField.authTag,
  githubTokenKeyVersion: tokenField.keyVersion,
};

function projectRow(over: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    userId: 'u1',
    name: 'demo',
    slug: 'demo',
    githubRepoFullName: 'octocat/demo',
    githubRepoId: 12345,
    branch: 'main',
    webhookId: 99,
    containerAppName: 'octocat-demo',
    liveUrl: 'https://octocat-demo.example.com',
    frameworkHint: null,
    autoDeploy: true,
    status: 'ACTIVE',
    stoppedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...over,
  };
}

function withRelations(over: Record<string, unknown> = {}) {
  return { ...projectRow(over), builds: [], deployments: [] };
}

const xrw = { 'X-Requested-With': 'XMLHttpRequest' };

beforeEach(() => {
  state.isDemo = false;
  for (const m of Object.values(mocks)) m.mockReset();

  mocks.userFindUnique.mockResolvedValue(userRow);
  mocks.octokitForUser.mockReturnValue({ request: vi.fn() });
  mocks.fetchBranchHeadCommit.mockResolvedValue({
    sha: 'abc1234def',
    message: 'newest commit',
    author: 'octocat',
  });
  mocks.buildCreate.mockResolvedValue({ id: 'b-new' });
  mocks.projectUpdate.mockResolvedValue(projectRow());
  // build.findFirst is used for BOTH the in-flight guard (where.status set) and
  // the last-build fallback in resolveLatestCommit (no status). Default: none.
  mocks.buildFindFirst.mockImplementation(
    async (args?: { where?: { status?: unknown } }) => {
      void args;
      return null;
    },
  );
});

describe('POST /:id/stop', () => {
  it('stops an active project: Azure stop + DB flip to STOPPED', async () => {
    mocks.projectFindFirst.mockResolvedValue(projectRow({ status: 'ACTIVE' }));
    mocks.projectFindUniqueOrThrow.mockResolvedValue(
      withRelations({ status: 'STOPPED', stoppedAt: new Date() }),
    );

    const res = await supertest(createApp())
      .post('/api/projects/p1/stop')
      .set(xrw);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('STOPPED');
    expect(mocks.stopContainerApp).toHaveBeenCalledWith('octocat-demo');
    expect(mocks.projectUpdate).toHaveBeenCalledTimes(1);
    const updateArg = mocks.projectUpdate.mock.calls[0]![0] as {
      where: { id: string };
      data: { status: string; stoppedAt: unknown };
    };
    expect(updateArg.where).toEqual({ id: 'p1' });
    expect(updateArg.data.status).toBe('STOPPED');
    expect(updateArg.data.stoppedAt).toBeInstanceOf(Date);
    expect(mocks.stopDemoProject).not.toHaveBeenCalled();
  });

  it('is idempotent when already stopped (no Azure call, no DB update)', async () => {
    mocks.projectFindFirst.mockResolvedValue(projectRow({ status: 'STOPPED' }));
    mocks.projectFindUniqueOrThrow.mockResolvedValue(withRelations({ status: 'STOPPED' }));

    const res = await supertest(createApp()).post('/api/projects/p1/stop').set(xrw);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('STOPPED');
    expect(mocks.stopContainerApp).not.toHaveBeenCalled();
    expect(mocks.projectUpdate).not.toHaveBeenCalled();
  });

  it('rejects with 409 BUILD_IN_PROGRESS when a build is in-flight (no Azure call)', async () => {
    mocks.projectFindFirst.mockResolvedValue(projectRow({ status: 'ACTIVE' }));
    mocks.buildFindFirst.mockResolvedValue({ id: 'b1' });

    const res = await supertest(createApp()).post('/api/projects/p1/stop').set(xrw);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('BUILD_IN_PROGRESS');
    expect(mocks.stopContainerApp).not.toHaveBeenCalled();
    expect(mocks.projectUpdate).not.toHaveBeenCalled();
  });

  it('does NOT flip the DB when the Azure stop fails (502, stays ACTIVE)', async () => {
    mocks.projectFindFirst.mockResolvedValue(projectRow({ status: 'ACTIVE' }));
    mocks.stopContainerApp.mockRejectedValue(new Error('azure down'));

    const res = await supertest(createApp()).post('/api/projects/p1/stop').set(xrw);

    expect(res.status).toBe(502);
    expect(res.body.error).toBe('AZURE_STOP_FAILED');
    expect(mocks.projectUpdate).not.toHaveBeenCalled();
  });

  it('demo session: DB-only via orchestrator, never reaches Azure', async () => {
    state.isDemo = true;
    mocks.projectFindFirst.mockResolvedValue(projectRow({ status: 'ACTIVE' }));
    mocks.stopDemoProject.mockResolvedValue(undefined);
    mocks.projectFindUniqueOrThrow.mockResolvedValue(withRelations({ status: 'STOPPED' }));

    const res = await supertest(createApp()).post('/api/projects/p1/stop').set(xrw);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('STOPPED');
    expect(mocks.stopDemoProject).toHaveBeenCalledWith('p1', 'u1');
    expect(mocks.stopContainerApp).not.toHaveBeenCalled();
  });
});

describe('POST /:id/resume', () => {
  it('resumes a stopped project and auto-builds the newest commit (autoDeploy on)', async () => {
    mocks.projectFindFirst.mockResolvedValue(projectRow({ status: 'STOPPED', autoDeploy: true }));
    mocks.projectFindUniqueOrThrow.mockResolvedValue(withRelations({ status: 'ACTIVE' }));

    const res = await supertest(createApp()).post('/api/projects/p1/resume').set(xrw);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ACTIVE');
    expect(res.body.resumedBuild).toEqual({ id: 'b-new' });
    expect(mocks.startContainerApp).toHaveBeenCalledWith('octocat-demo');
    expect(mocks.buildCreate).toHaveBeenCalledTimes(1);
    const data = mocks.buildCreate.mock.calls[0]![0].data as {
      commitSha: string;
      status: string;
    };
    expect(data.commitSha).toBe('abc1234def');
    expect(data.status).toBe('QUEUED');
  });

  it('resumes WITHOUT a build when autoDeploy is off', async () => {
    mocks.projectFindFirst.mockResolvedValue(projectRow({ status: 'STOPPED', autoDeploy: false }));
    mocks.projectFindUniqueOrThrow.mockResolvedValue(withRelations({ status: 'ACTIVE' }));

    const res = await supertest(createApp()).post('/api/projects/p1/resume').set(xrw);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ACTIVE');
    expect(res.body.resumedBuild).toBeNull();
    expect(mocks.startContainerApp).toHaveBeenCalledWith('octocat-demo');
    expect(mocks.buildCreate).not.toHaveBeenCalled();
  });

  it('is idempotent when already active (no Azure start, no build)', async () => {
    mocks.projectFindFirst.mockResolvedValue(projectRow({ status: 'ACTIVE' }));
    mocks.projectFindUniqueOrThrow.mockResolvedValue(withRelations({ status: 'ACTIVE' }));

    const res = await supertest(createApp()).post('/api/projects/p1/resume').set(xrw);

    expect(res.status).toBe(200);
    expect(res.body.resumedBuild).toBeNull();
    expect(mocks.startContainerApp).not.toHaveBeenCalled();
    expect(mocks.buildCreate).not.toHaveBeenCalled();
  });

  it('still resumes (200) when the auto-build commit lookup fails — best effort', async () => {
    mocks.projectFindFirst.mockResolvedValue(projectRow({ status: 'STOPPED', autoDeploy: true }));
    mocks.fetchBranchHeadCommit.mockRejectedValue(new Error('github down'));
    // no in-flight build AND no last build → resolveLatestCommit returns null
    mocks.buildFindFirst.mockResolvedValue(null);
    mocks.projectFindUniqueOrThrow.mockResolvedValue(withRelations({ status: 'ACTIVE' }));

    const res = await supertest(createApp()).post('/api/projects/p1/resume').set(xrw);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ACTIVE');
    expect(res.body.resumedBuild).toBeNull();
    expect(mocks.startContainerApp).toHaveBeenCalledWith('octocat-demo');
    expect(mocks.buildCreate).not.toHaveBeenCalled();
  });

  it('does NOT flip the DB when the Azure start fails (502, stays STOPPED)', async () => {
    mocks.projectFindFirst.mockResolvedValue(projectRow({ status: 'STOPPED' }));
    mocks.startContainerApp.mockRejectedValue(new Error('azure down'));

    const res = await supertest(createApp()).post('/api/projects/p1/resume').set(xrw);

    expect(res.status).toBe(502);
    expect(res.body.error).toBe('AZURE_START_FAILED');
    expect(mocks.projectUpdate).not.toHaveBeenCalled();
    expect(mocks.buildCreate).not.toHaveBeenCalled();
  });

  it('demo session: DB-only via orchestrator, never reaches Azure, never builds', async () => {
    state.isDemo = true;
    mocks.projectFindFirst.mockResolvedValue(projectRow({ status: 'STOPPED' }));
    mocks.resumeDemoProject.mockResolvedValue(undefined);
    mocks.projectFindUniqueOrThrow.mockResolvedValue(withRelations({ status: 'ACTIVE' }));

    const res = await supertest(createApp()).post('/api/projects/p1/resume').set(xrw);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ACTIVE');
    expect(res.body.resumedBuild).toBeNull();
    expect(mocks.resumeDemoProject).toHaveBeenCalledWith('p1', 'u1');
    expect(mocks.startContainerApp).not.toHaveBeenCalled();
    expect(mocks.buildCreate).not.toHaveBeenCalled();
  });
});

describe('POST /:id/rebuild on a stopped project', () => {
  it('rejects with 409 PROJECT_STOPPED before any GitHub/build work', async () => {
    mocks.projectFindFirst.mockResolvedValue(projectRow({ status: 'STOPPED' }));

    const res = await supertest(createApp()).post('/api/projects/p1/rebuild').set(xrw);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('PROJECT_STOPPED');
    expect(mocks.fetchBranchHeadCommit).not.toHaveBeenCalled();
    expect(mocks.buildCreate).not.toHaveBeenCalled();
  });
});
