// Set env vars before any module under test imports `env.ts` (which parses
// `process.env` at module load and `process.exit(1)`s on validation failure).
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

import { createHmac } from 'node:crypto';

import cookieParser from 'cookie-parser';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mocks must be declared with `vi.mock` *before* the modules that consume
// them are imported below (vitest hoists vi.mock calls to the top of the file).

vi.mock('../db.js', () => ({
  prisma: {
    user: {
      upsert: vi.fn(),
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('../services/github.js', () => ({
  exchangeCodeForToken: vi.fn(),
  fetchGithubProfile: vi.fn(),
  octokitForUser: vi.fn(),
  GithubAuthError: class GithubAuthError extends Error {},
}));

import { prisma } from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireXRequestedWith } from '../middleware/requireXRequestedWith.js';
import authRouter from './auth.js';

const COOKIE_SECRET = process.env.COOKIE_SECRET!;
const JWT_SECRET = process.env.JWT_SECRET!;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(COOKIE_SECRET));
  app.use('/api/auth', authRouter);

  // Standalone mounts for isolated middleware tests.
  app.post('/csrf-protected', requireXRequestedWith, (_req, res) => {
    res.status(200).json({ ok: true });
  });
  app.get('/csrf-protected', requireXRequestedWith, (_req, res) => {
    res.status(200).json({ ok: true });
  });
  app.get('/auth-only', requireAuth, (req, res) => {
    res.status(200).json({ user: req.user });
  });

  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/auth/github/callback', () => {
  it('returns 400 OAUTH_STATE_MISMATCH when state cookie does not match query', async () => {
    const app = buildApp();

    // Sign a state cookie value with cookie-parser's signature format so the
    // server sees it as a valid *signed* cookie but with a value that differs
    // from the `state` query param.
    const signedState = signCookieValue('cookie-state', COOKIE_SECRET);

    const res = await request(app)
      .get('/api/auth/github/callback')
      .query({ code: 'abc123', state: 'query-state-does-not-match' })
      .set('Cookie', [`oauth_state=s:${signedState}`]);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'OAUTH_STATE_MISMATCH' });
  });
});

describe('requireXRequestedWith middleware', () => {
  it('blocks POST without the X-Requested-With header (403 CSRF)', async () => {
    const app = buildApp();
    const res = await request(app).post('/csrf-protected').send({});
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'CSRF' });
  });

  it('allows POST with X-Requested-With: XMLHttpRequest', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/csrf-protected')
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('skips the check for GET requests', async () => {
    const app = buildApp();
    const res = await request(app).get('/csrf-protected');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

describe('requireAuth middleware', () => {
  it('returns 401 when no session cookie is present', async () => {
    const app = buildApp();
    const res = await request(app).get('/auth-only');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'UNAUTHORIZED' });
  });

  it('allows the request when a valid signed JWT cookie is present', async () => {
    const app = buildApp();

    const fakeUser = {
      id: 'user_123',
      githubLogin: 'octocat',
      email: 'octo@example.com',
      avatarUrl: 'https://example.com/a.png',
      isDemo: false,
    };
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(fakeUser);

    const token = jwt.sign({ sub: fakeUser.id }, JWT_SECRET, {
      algorithm: 'HS256',
      expiresIn: '7d',
    });
    const signedSession = signCookieValue(token, COOKIE_SECRET);

    const res = await request(app)
      .get('/auth-only')
      .set('Cookie', [`session=s:${signedSession}`]);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ user: fakeUser });
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'user_123' },
      select: {
        id: true,
        githubLogin: true,
        email: true,
        avatarUrl: true,
        isDemo: true,
        demoExpiresAt: true,
      },
    });
  });
});

describe('GET /api/auth/me', () => {
  it('echoes the current user including isDemo', async () => {
    const app = buildApp();

    const fakeUser = {
      id: 'user_456',
      githubLogin: 'octocat',
      email: 'octo@example.com',
      avatarUrl: 'https://example.com/a.png',
      isDemo: false,
    };
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(fakeUser);

    const token = jwt.sign({ sub: fakeUser.id }, JWT_SECRET, {
      algorithm: 'HS256',
      expiresIn: '7d',
    });
    const signedSession = signCookieValue(token, COOKIE_SECRET);

    const res = await request(app)
      .get('/api/auth/me')
      .set('Cookie', [`session=s:${signedSession}`]);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: 'user_456',
      githubLogin: 'octocat',
      email: 'octo@example.com',
      avatarUrl: 'https://example.com/a.png',
      isDemo: false,
    });
  });

  it('reports isDemo=true for a demo session', async () => {
    const app = buildApp();

    const demoUser = {
      id: 'demo_789',
      githubLogin: 'demo-abc123',
      email: null,
      avatarUrl: null,
      isDemo: true,
      demoExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    };
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(demoUser);

    const token = jwt.sign({ sub: demoUser.id }, JWT_SECRET, {
      algorithm: 'HS256',
      expiresIn: '7d',
    });
    const signedSession = signCookieValue(token, COOKIE_SECRET);

    const res = await request(app)
      .get('/api/auth/me')
      .set('Cookie', [`session=s:${signedSession}`]);

    expect(res.status).toBe(200);
    expect(res.body.isDemo).toBe(true);
  });
});

// --- helpers ---------------------------------------------------------------

/**
 * Replicates `cookie-signature.sign(value, secret)` so we can fabricate the
 * exact format `cookie-parser` expects for signed cookies (`s:<value>.<sig>`)
 * without pulling another dependency just for tests.
 */
function signCookieValue(value: string, secret: string): string {
  const sig = createHmac('sha256', secret)
    .update(value)
    .digest('base64')
    .replace(/=+$/, '');
  return `${value}.${sig}`;
}
