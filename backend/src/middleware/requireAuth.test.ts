// Set env before any module under test imports `env.ts`.
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

import { createHmac } from 'node:crypto';

import cookieParser from 'cookie-parser';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db.js', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
  },
}));

import { prisma } from '../db.js';
import { signSession } from '../lib/jwt.js';
import { requireAuth } from './requireAuth.js';

// Covers the REAL (non-demo) session paths — the demo-expiry paths live in
// requireAuth.demo.test.ts. Focus: tokens that pass the signed-cookie layer but
// fail JWT verification (so the JwtError → clear-cookie path runs), a deleted
// user, and that req.user never leaks demo-only columns.

const COOKIE_SECRET = process.env.COOKIE_SECRET!;
const JWT_SECRET = process.env.JWT_SECRET!;
const ISSUER = 'prodstack';
const AUDIENCE = 'prodstack-session';

const findUnique = prisma.user.findUnique as ReturnType<typeof vi.fn>;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(COOKIE_SECRET));
  app.get('/auth-only', requireAuth, (req, res) => {
    res.status(200).json({ user: req.user });
  });
  return app;
}

/** Wrap a raw JWT in cookie-parser's signed-cookie envelope (`s:<v>.<sig>`). */
function asSignedCookie(token: string): string {
  const sig = createHmac('sha256', COOKIE_SECRET).update(token).digest('base64').replace(/=+$/, '');
  return `session=s:${token}.${sig}`;
}

function clearedSessionCookie(res: { headers: Record<string, unknown> }): boolean {
  const h = res.headers['set-cookie'];
  const joined = Array.isArray(h) ? h.join('\n') : String(h ?? '');
  return /^session=/m.test(joined) && /Expires=Thu, 01 Jan 1970/.test(joined);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('requireAuth — real session paths', () => {
  it('401s without clearing when no session cookie is present', async () => {
    const res = await request(buildApp()).get('/auth-only');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'UNAUTHORIZED' });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('authenticates a valid token and exposes ONLY the sanitized projection', async () => {
    findUnique.mockResolvedValue({
      id: 'user_1',
      githubLogin: 'octocat',
      email: 'octo@example.com',
      avatarUrl: 'https://example.com/a.png',
      isDemo: false,
      demoExpiresAt: null,
    });

    const res = await request(buildApp())
      .get('/auth-only')
      .set('Cookie', [asSignedCookie(signSession('user_1'))]);

    expect(res.status).toBe(200);
    // demoExpiresAt is fetched for the gate check but MUST NOT leak onto req.user.
    expect(res.body.user).toEqual({
      id: 'user_1',
      githubLogin: 'octocat',
      email: 'octo@example.com',
      avatarUrl: 'https://example.com/a.png',
      isDemo: false,
    });
    expect(res.body.user).not.toHaveProperty('demoExpiresAt');
  });

  it('401s and CLEARS the cookie for a forged-signature token (passes cookie sig, fails JWT)', async () => {
    // Signed with a different JWT secret but wrapped in a VALID cookie signature,
    // so cookie-parser accepts it and verifySession is the layer that rejects it.
    const forged = jwt.sign({ sub: 'user_1' }, 'a-different-jwt-secret-32-chars-xx', {
      algorithm: 'HS256',
      issuer: ISSUER,
      audience: AUDIENCE,
      expiresIn: '7d',
    });

    const res = await request(buildApp())
      .get('/auth-only')
      .set('Cookie', [asSignedCookie(forged)]);

    expect(res.status).toBe(401);
    expect(clearedSessionCookie(res)).toBe(true);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('401s and CLEARS the cookie for an expired token', async () => {
    const expired = jwt.sign({ sub: 'user_1' }, JWT_SECRET, {
      algorithm: 'HS256',
      issuer: ISSUER,
      audience: AUDIENCE,
      expiresIn: -10,
    });

    const res = await request(buildApp())
      .get('/auth-only')
      .set('Cookie', [asSignedCookie(expired)]);

    expect(res.status).toBe(401);
    expect(clearedSessionCookie(res)).toBe(true);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('401s and CLEARS the cookie when the user no longer exists (revocation by deletion)', async () => {
    findUnique.mockResolvedValue(null);

    const res = await request(buildApp())
      .get('/auth-only')
      .set('Cookie', [asSignedCookie(signSession('ghost_user'))]);

    expect(res.status).toBe(401);
    expect(clearedSessionCookie(res)).toBe(true);
    expect(findUnique).toHaveBeenCalledOnce();
  });
});
