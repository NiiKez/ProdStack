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

const state = vi.hoisted(() => ({
  stubAuth: true,
}));

const mocks = vi.hoisted(() => ({
  userUpdate: vi.fn(),
  userDelete: vi.fn(),
  projectCount: vi.fn(),
  projectFindMany: vi.fn(),
  deleteContainerApp: vi.fn(),
}));

vi.mock('../db.js', () => ({
  prisma: {
    user: { update: mocks.userUpdate, delete: mocks.userDelete },
    project: { count: mocks.projectCount, findMany: mocks.projectFindMany },
  },
}));

vi.mock('../services/azure/index.js', () => ({
  deleteContainerApp: mocks.deleteContainerApp,
}));

vi.mock('../middleware/requireAuth.js', () => ({
  requireAuth: (
    req: { user?: unknown },
    res: { status: (n: number) => { json: (b: unknown) => void } },
    next: () => void,
  ) => {
    if (state.stubAuth) {
      req.user = {
        id: 'u1',
        githubLogin: 'octocat',
        email: 'octo@example.com',
        avatarUrl: null,
      };
      next();
      return;
    }
    res.status(401).json({ error: 'UNAUTHENTICATED' });
  },
}));

vi.mock('./auth.js', async () => {
  const express = await import('express');
  return { default: express.Router() };
});

const { createApp } = await import('../app.js');
const supertest = (await import('supertest')).default;

beforeEach(() => {
  state.stubAuth = true;
  mocks.userUpdate.mockReset();
  mocks.userDelete.mockReset();
  mocks.projectCount.mockReset();
  mocks.projectFindMany.mockReset();
  mocks.deleteContainerApp.mockReset();

  mocks.userUpdate.mockResolvedValue({});
  mocks.userDelete.mockResolvedValue({});
  mocks.projectCount.mockResolvedValue(0);
  mocks.projectFindMany.mockResolvedValue([]);
  mocks.deleteContainerApp.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/account', () => {
  it('returns the current user with connection flags and counts', async () => {
    mocks.projectCount.mockResolvedValueOnce(3);
    const app = createApp();
    const res = await supertest(app).get('/api/account');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: 'u1',
      githubLogin: 'octocat',
      github: { connected: true },
      azure: { mode: 'stub' },
      counts: { projects: 3 },
    });
  });

  it('401 when unauthenticated', async () => {
    state.stubAuth = false;
    const app = createApp();
    const res = await supertest(app).get('/api/account');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/account/disconnect-github', () => {
  it('refuses if the user has live projects', async () => {
    mocks.projectCount.mockResolvedValueOnce(2);
    const app = createApp();
    const res = await supertest(app)
      .post('/api/account/disconnect-github')
      .set('X-Requested-With', 'XMLHttpRequest');
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'HAS_ACTIVE_PROJECTS' });
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });

  it('clears encrypted token columns and the session', async () => {
    const app = createApp();
    const res = await supertest(app)
      .post('/api/account/disconnect-github')
      .set('X-Requested-With', 'XMLHttpRequest');
    expect(res.status).toBe(204);
    expect(mocks.userUpdate).toHaveBeenCalledTimes(1);
    const call = mocks.userUpdate.mock.calls[0]![0] as {
      data: { githubTokenCiphertext: Buffer; githubTokenKeyVersion: number };
    };
    expect(call.data.githubTokenCiphertext.length).toBe(0);
    expect(call.data.githubTokenKeyVersion).toBe(0);
    const setCookie = res.headers['set-cookie'];
    const cookieHeader = Array.isArray(setCookie) ? setCookie.join('\n') : (setCookie ?? '');
    // `res.clearCookie` sets an expired cookie — we just need to see the
    // session cookie name with a past expiry, not assert the exact value.
    expect(cookieHeader).toMatch(/^session=/m);
    expect(cookieHeader).toMatch(/Expires=Thu, 01 Jan 1970/);
  });

  it('requires X-Requested-With (CSRF gate)', async () => {
    const app = createApp();
    const res = await supertest(app).post('/api/account/disconnect-github');
    expect(res.status).toBe(403);
  });
});

describe('PUT /api/account/azure-credentials', () => {
  it('returns the global-SP stub status', async () => {
    const app = createApp();
    const res = await supertest(app)
      .put('/api/account/azure-credentials')
      .set('X-Requested-With', 'XMLHttpRequest');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: 'global-sp' });
  });
});

describe('DELETE /api/account', () => {
  it('rejects without X-Confirm: DELETE header', async () => {
    const app = createApp();
    const res = await supertest(app)
      .delete('/api/account')
      .set('X-Requested-With', 'XMLHttpRequest');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'CONFIRMATION_REQUIRED' });
    expect(mocks.userDelete).not.toHaveBeenCalled();
  });

  it('deletes the user and tears down live container apps best-effort', async () => {
    mocks.projectFindMany.mockResolvedValueOnce([
      { containerAppName: 'octocat-app-a' },
      { containerAppName: 'octocat-app-b' },
    ]);
    const app = createApp();
    const res = await supertest(app)
      .delete('/api/account')
      .set('X-Requested-With', 'XMLHttpRequest')
      .set('X-Confirm', 'DELETE');
    expect(res.status).toBe(204);
    expect(mocks.userDelete).toHaveBeenCalledWith({ where: { id: 'u1' } });
    expect(mocks.deleteContainerApp).toHaveBeenCalledTimes(2);
    expect(mocks.deleteContainerApp).toHaveBeenCalledWith('octocat-app-a');
    expect(mocks.deleteContainerApp).toHaveBeenCalledWith('octocat-app-b');
  });

  it('swallows azure delete failures and still 204s', async () => {
    mocks.projectFindMany.mockResolvedValueOnce([{ containerAppName: 'octocat-a' }]);
    mocks.deleteContainerApp.mockRejectedValueOnce(new Error('azure boom'));
    const app = createApp();
    const res = await supertest(app)
      .delete('/api/account')
      .set('X-Requested-With', 'XMLHttpRequest')
      .set('X-Confirm', 'DELETE');
    expect(res.status).toBe(204);
    expect(mocks.userDelete).toHaveBeenCalled();
  });
});
