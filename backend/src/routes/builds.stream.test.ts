// C2: the SSE log-stream endpoint caps how many concurrent streams one user may
// hold open (logStreamRegistry). This pins the WIRING — that the route rejects
// with 429 TOO_MANY_STREAMS when the registry is at capacity, before opening the
// stream — by mocking the registry. The acquire/release LOGIC itself is covered
// by lib/streamRegistry.test.ts, and the happy path (acquire→release on a
// completed stream) by the real registry in builds.test.ts.
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

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  buildFindFirst: vi.fn(),
  buildFindUnique: vi.fn(),
  logLineFindMany: vi.fn(),
  tryAcquire: vi.fn(),
  release: vi.fn(),
}));

vi.mock('../db.js', () => ({
  prisma: {
    build: { findFirst: mocks.buildFindFirst, findUnique: mocks.buildFindUnique },
    logLine: { findMany: mocks.logLineFindMany },
  },
}));

vi.mock('../middleware/requireAuth.js', () => ({
  requireAuth: (
    req: { user?: unknown },
    _res: unknown,
    next: () => void,
  ) => {
    req.user = { id: 'u1', githubLogin: 'octocat', email: null, avatarUrl: null };
    next();
  },
}));

vi.mock('./auth.js', async () => {
  const express = await import('express');
  return { default: express.Router() };
});

vi.mock('../lib/streamRegistry.js', () => ({
  logStreamRegistry: { tryAcquire: mocks.tryAcquire, release: mocks.release },
}));

const { createApp } = await import('../app.js');
const supertest = (await import('supertest')).default;

const ownedBuild = {
  id: 'build-1',
  status: 'BUILDING',
  project: { id: 'project-1', name: 'app', githubRepoFullName: 'octocat/app', containerAppName: 'octocat-app', liveUrl: null },
};

beforeEach(() => {
  mocks.buildFindFirst.mockReset();
  mocks.tryAcquire.mockReset();
  mocks.release.mockReset();
  mocks.buildFindFirst.mockResolvedValue(ownedBuild);
});

describe('GET /api/builds/:id/logs/stream — concurrency cap', () => {
  it('429s TOO_MANY_STREAMS (keyed on the user) when the registry is at capacity', async () => {
    mocks.tryAcquire.mockReturnValue(false);
    const res = await supertest(createApp()).get('/api/builds/build-1/logs/stream');
    expect(res.status).toBe(429);
    expect(res.body.error).toBe('TOO_MANY_STREAMS');
    expect(res.headers['retry-after']).toBe('5');
    // The cap is per authenticated user, and nothing was streamed.
    expect(mocks.tryAcquire).toHaveBeenCalledWith('u1');
    expect(mocks.logLineFindMany).not.toHaveBeenCalled();
  });

  it('does not consume a slot when the build is not the user’s (404 before acquire)', async () => {
    // Ownership check runs first; a foreign/missing build must not reserve a slot.
    mocks.buildFindFirst.mockResolvedValue(null);
    const res = await supertest(createApp()).get('/api/builds/build-1/logs/stream');
    expect(res.status).toBe(404);
    expect(mocks.tryAcquire).not.toHaveBeenCalled();
  });
});
