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

  it('caps the projectId IN-list at 50 ids (M8 DB-load guard)', async () => {
    // A long CSV could otherwise fan out to ~650 ids in one Prisma IN(...). The
    // route slices the validated list to 50; the rest are dropped.
    mocks.deploymentFindMany.mockResolvedValue([]);
    const ids = Array.from({ length: 200 }, (_v, i) => `p${i}`);
    const res = await supertest(createApp()).get(
      `/api/deployments?projectId=${ids.join(',')}`,
    );
    expect(res.status).toBe(200);
    const where = mocks.deploymentFindMany.mock.calls[0]![0]!.where;
    expect(where.projectId.in).toHaveLength(50);
    // The first 50 (in order) are the ones kept.
    expect(where.projectId.in).toEqual(ids.slice(0, 50));
    // User-scoping must stay intact regardless of the filter.
    expect(where.project).toEqual({ userId: 'u1', deletedAt: null });
  });

  it('drops malformed projectId tokens, keeping only cuid-ish ids (M8)', async () => {
    // Anything outside ^[a-z0-9]{1,40}$ (uppercase, punctuation, over-long,
    // injection-y strings) is dropped before reaching Prisma. A valid id in the
    // same CSV still goes through.
    mocks.deploymentFindMany.mockResolvedValue([]);
    const overLong = 'a'.repeat(41);
    const malformed = [
      'GOODBUTUPPER',
      'has space',
      "p1'; drop table",
      '../etc/passwd',
      overLong,
    ];
    const csv = ['good1', ...malformed, 'good2'].join(',');
    const res = await supertest(createApp()).get(`/api/deployments?projectId=${encodeURIComponent(csv)}`);
    expect(res.status).toBe(200);
    const where = mocks.deploymentFindMany.mock.calls[0]![0]!.where;
    // Only the well-formed lowercase-alnum ids survive.
    expect(where.projectId.in).toEqual(['good1', 'good2']);
  });

  it('omits the projectId filter entirely when every token is malformed (M8)', async () => {
    // If nothing valid remains, the filter falls back to the user-scoped default
    // rather than passing an empty IN([]) (which would match nothing).
    mocks.deploymentFindMany.mockResolvedValue([]);
    const res = await supertest(createApp()).get(
      '/api/deployments?projectId=' + encodeURIComponent('UPPER,has space,..'),
    );
    expect(res.status).toBe(200);
    const where = mocks.deploymentFindMany.mock.calls[0]![0]!.where;
    expect(where.projectId).toBeUndefined();
    expect(where.project).toEqual({ userId: 'u1', deletedAt: null });
  });

  it('still accepts a small valid projectId list unchanged (M8 regression)', async () => {
    mocks.deploymentFindMany.mockResolvedValue([]);
    const res = await supertest(createApp()).get('/api/deployments?projectId=p1,p2,p3');
    expect(res.status).toBe(200);
    const where = mocks.deploymentFindMany.mock.calls[0]![0]!.where;
    expect(where.projectId).toEqual({ in: ['p1', 'p2', 'p3'] });
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
