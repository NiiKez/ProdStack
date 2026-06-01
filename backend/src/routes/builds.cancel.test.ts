// Set env vars before importing anything that loads `env.ts`.
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
  buildFindFirst: vi.fn(),
  buildUpdateMany: vi.fn(),
  buildUpdate: vi.fn(),
}));

vi.mock('../db.js', () => ({
  prisma: {
    build: {
      findFirst: mocks.buildFindFirst,
      updateMany: mocks.buildUpdateMany,
      update: mocks.buildUpdate,
    },
  },
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

function ownedBuild(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'build-1',
    status: 'QUEUED',
    commitSha: 'abc1234def',
    commitMessage: 'ship it',
    commitAuthor: 'octocat',
    branch: 'main',
    imageTag: null,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    errorMessage: null,
    createdAt: new Date('2026-05-31T09:59:00Z'),
    project: {
      id: 'project-1',
      name: 'app',
      githubRepoFullName: 'octocat/app',
      containerAppName: 'octocat-app',
      liveUrl: null,
    },
    ...over,
  };
}

beforeEach(() => {
  state.stubAuth = true;
  mocks.buildFindFirst.mockReset();
  mocks.buildUpdateMany.mockReset();
  mocks.buildUpdate.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/builds/:id/cancel', () => {
  it('403 without the X-Requested-With header (CSRF gate)', async () => {
    const res = await supertest(createApp()).post('/api/builds/build-1/cancel');
    expect(res.status).toBe(403);
    expect(mocks.buildFindFirst).not.toHaveBeenCalled();
  });

  it('404 BUILD_NOT_FOUND when the build is not owned or missing', async () => {
    mocks.buildFindFirst.mockResolvedValue(null);
    const res = await supertest(createApp())
      .post('/api/builds/build-1/cancel')
      .set('X-Requested-With', 'XMLHttpRequest');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('BUILD_NOT_FOUND');
    expect(mocks.buildUpdateMany).not.toHaveBeenCalled();
    expect(mocks.buildUpdate).not.toHaveBeenCalled();
  });

  it('409 BUILD_NOT_CANCELLABLE for an already-terminal (READY) build', async () => {
    mocks.buildFindFirst.mockResolvedValue(ownedBuild({ status: 'READY' }));
    const res = await supertest(createApp())
      .post('/api/builds/build-1/cancel')
      .set('X-Requested-With', 'XMLHttpRequest');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('BUILD_NOT_CANCELLABLE');
    expect(mocks.buildUpdateMany).not.toHaveBeenCalled();
    expect(mocks.buildUpdate).not.toHaveBeenCalled();
  });

  it('fast path: cancels an unclaimed QUEUED build → 200 CANCELLED, no cooperative update', async () => {
    mocks.buildFindFirst.mockResolvedValue(ownedBuild({ status: 'QUEUED' }));
    mocks.buildUpdateMany.mockResolvedValue({ count: 1 });
    const res = await supertest(createApp())
      .post('/api/builds/build-1/cancel')
      .set('X-Requested-With', 'XMLHttpRequest');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: 'build-1',
      status: 'CANCELLED',
      cancelRequested: false,
    });
    // The conditional updateMany scopes to an unclaimed QUEUED row.
    const where = mocks.buildUpdateMany.mock.calls[0]![0]!.where as {
      id: string;
      status: string;
      claimedAt: null;
    };
    expect(where).toMatchObject({ id: 'build-1', status: 'QUEUED', claimedAt: null });
    // It was cancelled atomically; we must NOT also flip cancelRequested.
    expect(mocks.buildUpdate).not.toHaveBeenCalled();
  });

  it('cooperative path: sets cancelRequested on a claimed/in-flight build → 202', async () => {
    mocks.buildFindFirst.mockResolvedValue(ownedBuild({ status: 'BUILDING' }));
    // Fast-path updateMany loses the race (worker already claimed it) → count 0;
    // the cooperative updateMany then flips the flag → count 1.
    mocks.buildUpdateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    const res = await supertest(createApp())
      .post('/api/builds/build-1/cancel')
      .set('X-Requested-With', 'XMLHttpRequest');
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      id: 'build-1',
      status: 'BUILDING',
      cancelRequested: true,
    });
    // The cooperative write is conditional on a still-cancellable status, so a
    // build that finished between the read and the write can't be touched.
    const coopWhere = mocks.buildUpdateMany.mock.calls[1]![0]!.where as {
      id: string;
      status: { notIn: string[] };
    };
    expect(coopWhere.id).toBe('build-1');
    expect(coopWhere.status.notIn).toEqual(
      expect.arrayContaining(['READY', 'FAILED', 'CANCELLED']),
    );
    // No single-row `update` (that would 500 on a row deleted mid-cancel).
    expect(mocks.buildUpdate).not.toHaveBeenCalled();
  });

  it('409 BUILD_NOT_CANCELLABLE when the build finishes between the read and the cooperative write', async () => {
    // Read sees it in-flight, but both updateManys match zero rows: the fast
    // path because it's claimed, the cooperative path because it just reached a
    // terminal status (or the row was deleted by a project cascade).
    mocks.buildFindFirst.mockResolvedValue(ownedBuild({ status: 'DEPLOYING' }));
    mocks.buildUpdateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 });
    const res = await supertest(createApp())
      .post('/api/builds/build-1/cancel')
      .set('X-Requested-With', 'XMLHttpRequest');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('BUILD_NOT_CANCELLABLE');
    expect(mocks.buildUpdate).not.toHaveBeenCalled();
  });
});
