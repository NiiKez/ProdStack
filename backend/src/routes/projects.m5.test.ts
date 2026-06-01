// M5 per-project sub-routes: builds list, deployments list, rollback.
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

const state = vi.hoisted(() => ({ stubAuth: true }));

const mocks = vi.hoisted(() => ({
  projectFindFirst: vi.fn(),
  buildFindMany: vi.fn(),
  deploymentFindMany: vi.fn(),
  envVarFindMany: vi.fn(),
  rollbackToDeployment: vi.fn(),
}));

vi.mock('../db.js', () => ({
  prisma: {
    project: { findFirst: mocks.projectFindFirst },
    build: { findMany: mocks.buildFindMany },
    deployment: { findMany: mocks.deploymentFindMany },
    envVar: { findMany: mocks.envVarFindMany },
  },
}));

vi.mock('../services/deploy.js', () => ({
  rollbackToDeployment: mocks.rollbackToDeployment,
  IN_FLIGHT_BUILD_STATUSES: ['QUEUED', 'CLONING', 'BUILDING', 'PUSHING', 'DEPLOYING'],
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

const project = { id: 'p1', userId: 'u1', containerAppName: 'octocat-app', deletedAt: null };

function buildRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'b1',
    status: 'READY',
    commitSha: 'abc1234',
    commitMessage: 'ship',
    commitAuthor: 'octocat',
    branch: 'main',
    imageTag: 'prodstack.azurecr.io/octocat-app:abc1234',
    startedAt: new Date('2026-05-31T10:00:00Z'),
    finishedAt: new Date('2026-05-31T10:01:00Z'),
    durationMs: 60_000,
    errorMessage: null,
    createdAt: new Date('2026-05-31T09:59:00Z'),
    ...over,
  };
}

beforeEach(() => {
  state.stubAuth = true;
  for (const m of Object.values(mocks)) m.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/projects/:id/builds', () => {
  it('404 when the project is not owned', async () => {
    mocks.projectFindFirst.mockResolvedValue(null);
    const res = await supertest(createApp()).get('/api/projects/p1/builds');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('PROJECT_NOT_FOUND');
    expect(mocks.buildFindMany).not.toHaveBeenCalled();
  });

  it('returns items + null nextCursor when the page is not full', async () => {
    mocks.projectFindFirst.mockResolvedValue(project);
    mocks.buildFindMany.mockResolvedValue([buildRow()]);
    const res = await supertest(createApp()).get('/api/projects/p1/builds?limit=20');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe('b1');
    expect(res.body.nextCursor).toBeNull();
  });

  it('sets nextCursor to the last item id when more rows exist', async () => {
    mocks.projectFindFirst.mockResolvedValue(project);
    // limit=1 → route fetches 2 (limit+1); 2 returned means hasMore.
    mocks.buildFindMany.mockResolvedValue([buildRow({ id: 'b1' }), buildRow({ id: 'b2' })]);
    const res = await supertest(createApp()).get('/api/projects/p1/builds?limit=1');
    expect(res.body.items).toHaveLength(1);
    expect(res.body.nextCursor).toBe('b1');
    const args = mocks.buildFindMany.mock.calls[0]![0]!;
    expect(args.take).toBe(2);
  });

  it('applies status + branch filters and a duration sort', async () => {
    mocks.projectFindFirst.mockResolvedValue(project);
    mocks.buildFindMany.mockResolvedValue([]);
    await supertest(createApp()).get(
      '/api/projects/p1/builds?status=READY,FAILED,bogus&branch=dev&sort=duration&order=asc',
    );
    const args = mocks.buildFindMany.mock.calls[0]![0]!;
    expect(args.where).toMatchObject({
      projectId: 'p1',
      status: { in: ['READY', 'FAILED'] },
      branch: 'dev',
    });
    expect(args.orderBy[0]).toEqual({ durationMs: 'asc' });
  });

  it('passes the cursor through to a keyset query', async () => {
    mocks.projectFindFirst.mockResolvedValue(project);
    mocks.buildFindMany.mockResolvedValue([]);
    await supertest(createApp()).get('/api/projects/p1/builds?cursor=b9');
    const args = mocks.buildFindMany.mock.calls[0]![0]!;
    expect(args.cursor).toEqual({ id: 'b9' });
    expect(args.skip).toBe(1);
  });
});

describe('GET /api/projects/:id/deployments', () => {
  it('returns serialized deployments with build commit info', async () => {
    mocks.projectFindFirst.mockResolvedValue(project);
    mocks.deploymentFindMany.mockResolvedValue([
      {
        id: 'd1',
        revisionName: 'octocat-app--rev1',
        active: true,
        rolledBack: false,
        createdAt: new Date('2026-05-31T10:01:00Z'),
        build: buildRow(),
      },
    ]);
    const res = await supertest(createApp()).get('/api/projects/p1/deployments');
    expect(res.status).toBe(200);
    expect(res.body.items[0]).toMatchObject({
      id: 'd1',
      active: true,
      rolledBack: false,
      build: { commitSha: 'abc1234', status: 'READY' },
    });
  });

  it('filters to active only when requested', async () => {
    mocks.projectFindFirst.mockResolvedValue(project);
    mocks.deploymentFindMany.mockResolvedValue([]);
    await supertest(createApp()).get('/api/projects/p1/deployments?activeOnly=true');
    const args = mocks.deploymentFindMany.mock.calls[0]![0]!;
    expect(args.where).toMatchObject({ projectId: 'p1', active: true });
  });
});

describe('POST /api/projects/:id/deployments/:deploymentId/rollback', () => {
  it('403 without X-Requested-With', async () => {
    const res = await supertest(createApp()).post(
      '/api/projects/p1/deployments/d1/rollback',
    );
    expect(res.status).toBe(403);
    expect(mocks.rollbackToDeployment).not.toHaveBeenCalled();
  });

  it('rolls back and returns the new active deployment', async () => {
    mocks.rollbackToDeployment.mockResolvedValue({
      id: 'd2',
      revisionName: 'octocat-app--rev1',
      active: true,
      rolledBack: true,
      createdAt: new Date('2026-06-01T12:00:00Z'),
      build: buildRow(),
    });
    const res = await supertest(createApp())
      .post('/api/projects/p1/deployments/d1/rollback')
      .set('X-Requested-With', 'XMLHttpRequest');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 'd2', active: true, rolledBack: true });
    expect(mocks.rollbackToDeployment).toHaveBeenCalledWith({
      projectId: 'p1',
      deploymentId: 'd1',
      userId: 'u1',
    });
  });

  it('propagates a 404 from the service for an unknown deployment', async () => {
    const { HttpError } = await import('../lib/errors.js');
    mocks.rollbackToDeployment.mockRejectedValue(new HttpError(404, 'DEPLOYMENT_NOT_FOUND'));
    const res = await supertest(createApp())
      .post('/api/projects/p1/deployments/d1/rollback')
      .set('X-Requested-With', 'XMLHttpRequest');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('DEPLOYMENT_NOT_FOUND');
  });
});
