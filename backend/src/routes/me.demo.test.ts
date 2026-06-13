// Demo-isolation regression guard for the `/api/account` router (me.ts).
// Mirrors the structural-safety pattern in projects.isolation.test.ts: a demo
// session must be PHYSICALLY UNABLE to reach a real Azure operation, so each
// test asserts the Azure mock was NEVER called for a demo session — while the
// non-demo path still DOES call it (proving the real path is intact).
// (H1 fix — docs/DEMO_MODE.md §14.)
//
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

// The acting session — flipped per test to simulate a demo vs. real user.
const state = vi.hoisted(() => ({
  user: { id: 'demo-A', githubLogin: 'demo-aaa', email: null, avatarUrl: null, isDemo: true },
}));

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userDelete: vi.fn(),
  projectCount: vi.fn(),
  projectFindMany: vi.fn(),
  deleteContainerApp: vi.fn(),
  pingAzure: vi.fn(),
}));

vi.mock('../db.js', () => ({
  prisma: {
    user: {
      findUnique: mocks.userFindUnique,
      delete: mocks.userDelete,
    },
    project: { count: mocks.projectCount, findMany: mocks.projectFindMany },
  },
}));

// Both Azure functions are spies here (me.test.ts delegates pingAzure to the
// real stub — we can't, since the whole point is to assert it is NEVER called).
vi.mock('../services/azure/index.js', () => ({
  deleteContainerApp: mocks.deleteContainerApp,
  pingAzure: mocks.pingAzure,
}));

vi.mock('../middleware/requireAuth.js', () => ({
  requireAuth: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { ...state.user };
    next();
  },
}));

vi.mock('./auth.js', async () => {
  const express = await import('express');
  return { default: express.Router() };
});

const { createApp } = await import('../app.js');
const supertest = (await import('supertest')).default;

function asUser(isDemo: boolean) {
  state.user = {
    id: isDemo ? 'demo-A' : 'real-owner',
    githubLogin: isDemo ? 'demo-aaa' : 'octocat',
    email: null,
    avatarUrl: null,
    isDemo,
  };
}

beforeEach(() => {
  asUser(true);
  mocks.userFindUnique.mockReset();
  mocks.userDelete.mockReset();
  mocks.projectCount.mockReset();
  mocks.projectFindMany.mockReset();
  mocks.deleteContainerApp.mockReset();
  mocks.pingAzure.mockReset();

  mocks.userFindUnique.mockResolvedValue({ githubTokenCiphertext: Buffer.from([1, 2, 3]) });
  mocks.userDelete.mockResolvedValue({});
  mocks.projectCount.mockResolvedValue(0);
  mocks.projectFindMany.mockResolvedValue([]);
  mocks.deleteContainerApp.mockResolvedValue(undefined);
  mocks.pingAzure.mockResolvedValue({ ok: true, mode: 'managed-identity', latencyMs: 1 });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/account/azure/test — demo isolation', () => {
  it('returns a canned demo success WITHOUT calling pingAzure for a demo session', async () => {
    asUser(true);
    const res = await supertest(createApp())
      .post('/api/account/azure/test')
      .set('X-Requested-With', 'XMLHttpRequest');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, mode: 'demo' });
    // Structural safety: a demo visitor must never trigger a real ARM read.
    expect(mocks.pingAzure).not.toHaveBeenCalled();
  });

  it('still calls pingAzure for a real (non-demo) session', async () => {
    asUser(false);
    const res = await supertest(createApp())
      .post('/api/account/azure/test')
      .set('X-Requested-With', 'XMLHttpRequest');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
    expect(mocks.pingAzure).toHaveBeenCalledTimes(1);
  });
});

describe('DELETE /api/account — demo isolation', () => {
  it('deletes the demo user WITHOUT calling deleteContainerApp (DB cascade only)', async () => {
    asUser(true);
    // Even if a demo session somehow has live project rows, no Azure teardown
    // must fire — demo projects have no real container app.
    mocks.projectFindMany.mockResolvedValueOnce([
      { containerAppName: 'demo-app-a' },
      { containerAppName: 'demo-app-b' },
    ]);
    const res = await supertest(createApp())
      .delete('/api/account')
      .set('X-Requested-With', 'XMLHttpRequest')
      .set('X-Confirm', 'DELETE');
    expect(res.status).toBe(204);
    // The DB cascade path still runs — the demo user IS deleted.
    expect(mocks.userDelete).toHaveBeenCalledWith({ where: { id: 'demo-A' } });
    // Structural safety: no real Azure delete for a demo session.
    expect(mocks.deleteContainerApp).not.toHaveBeenCalled();
  });

  it('still tears down container apps for a real (non-demo) session', async () => {
    asUser(false);
    mocks.projectFindMany.mockResolvedValueOnce([
      { containerAppName: 'octocat-app-a' },
      { containerAppName: 'octocat-app-b' },
    ]);
    const res = await supertest(createApp())
      .delete('/api/account')
      .set('X-Requested-With', 'XMLHttpRequest')
      .set('X-Confirm', 'DELETE');
    expect(res.status).toBe(204);
    expect(mocks.userDelete).toHaveBeenCalledWith({ where: { id: 'real-owner' } });
    expect(mocks.deleteContainerApp).toHaveBeenCalledTimes(2);
    expect(mocks.deleteContainerApp).toHaveBeenCalledWith('octocat-app-a');
    expect(mocks.deleteContainerApp).toHaveBeenCalledWith('octocat-app-b');
  });
});
