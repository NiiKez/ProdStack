// Separate test file (= separate, isolated module registry) so `env` freezes
// with ENABLE_DEMO=false. The disabled (404) case can't share a process-module
// with the enabled case in demoAuth.test.ts (env.ts freezes once per registry).
//
// Same freeze-timing pattern as demoAuth.test.ts: set env in `vi.hoisted` (above
// every import) and dynamically `await import()` the router.
import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
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
  process.env.ENABLE_DEMO = 'false';
});

const mocks = vi.hoisted(() => ({
  userCount: vi.fn(),
  userCreate: vi.fn(),
  seedDemoWorkspace: vi.fn(),
}));

vi.mock('../db.js', () => ({
  prisma: {
    user: {
      count: mocks.userCount,
      create: mocks.userCreate,
    },
  },
}));

vi.mock('../services/demo/demoOrchestrator.js', () => ({
  seedDemoWorkspace: mocks.seedDemoWorkspace,
}));

const { requireXRequestedWith } = await import('../middleware/requireXRequestedWith.js');
const demoAuthRouter = (await import('./demoAuth.js')).default;

const COOKIE_SECRET = process.env.COOKIE_SECRET!;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(COOKIE_SECRET));
  app.use('/api/auth', requireXRequestedWith, demoAuthRouter);
  return app;
}

beforeEach(() => {
  mocks.userCount.mockReset();
  mocks.userCreate.mockReset();
  mocks.seedDemoWorkspace.mockReset();
});

describe('GET /api/auth/demo-login (ENABLE_DEMO=false)', () => {
  it('returns 404 NOT_FOUND and touches nothing — the surface is invisible', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/auth/demo-login').redirects(0);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'NOT_FOUND' });
    expect(mocks.userCount).not.toHaveBeenCalled();
    expect(mocks.userCreate).not.toHaveBeenCalled();
    expect(mocks.seedDemoWorkspace).not.toHaveBeenCalled();
  });
});
