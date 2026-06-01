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

const mocks = vi.hoisted(() => ({ deploymentFindMany: vi.fn() }));

vi.mock('../db.js', () => ({
  prisma: { deployment: { findMany: mocks.deploymentFindMany } },
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

function deploymentRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'd1',
    revisionName: 'app--rev1',
    active: true,
    rolledBack: false,
    createdAt: new Date('2026-05-31T10:01:00Z'),
    project: { id: 'p1', name: 'app', liveUrl: 'https://app.example.io' },
    build: {
      id: 'b1',
      status: 'READY',
      commitSha: 'abc1234',
      commitMessage: 'ship',
      commitAuthor: 'octocat',
      branch: 'main',
      imageTag: 'reg/app:abc1234',
    },
    ...over,
  };
}

beforeEach(() => {
  state.stubAuth = true;
  mocks.deploymentFindMany.mockReset();
});

afterEach(() => vi.clearAllMocks());

describe('GET /api/deployments', () => {
  it('401 when unauthenticated', async () => {
    state.stubAuth = false;
    const res = await supertest(createApp()).get('/api/deployments');
    expect(res.status).toBe(401);
  });

  it('scopes the query to the user’s live projects', async () => {
    mocks.deploymentFindMany.mockResolvedValue([deploymentRow()]);
    const res = await supertest(createApp()).get('/api/deployments');
    expect(res.status).toBe(200);
    expect(res.body.items[0]).toMatchObject({
      id: 'd1',
      project: { id: 'p1', name: 'app' },
      build: { commitSha: 'abc1234' },
    });
    const where = mocks.deploymentFindMany.mock.calls[0]![0]!.where;
    expect(where.project).toEqual({ userId: 'u1', deletedAt: null });
  });

  it('applies project, status and activeOnly filters', async () => {
    mocks.deploymentFindMany.mockResolvedValue([]);
    await supertest(createApp()).get(
      '/api/deployments?projectId=p1,p2&status=READY,nope&activeOnly=true',
    );
    const where = mocks.deploymentFindMany.mock.calls[0]![0]!.where;
    expect(where.projectId).toEqual({ in: ['p1', 'p2'] });
    expect(where.active).toBe(true);
    expect(where.build).toEqual({ status: { in: ['READY'] } });
  });

  it('paginates with a keyset cursor', async () => {
    mocks.deploymentFindMany.mockResolvedValue([
      deploymentRow({ id: 'd1' }),
      deploymentRow({ id: 'd2' }),
    ]);
    const res = await supertest(createApp()).get('/api/deployments?limit=1');
    expect(res.body.items).toHaveLength(1);
    expect(res.body.nextCursor).toBe('d1');
  });
});
