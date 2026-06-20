// requireAuth's two ERROR-PROPAGATION branches (distinct from the 401 reject
// paths covered in requireAuth.test.ts):
//   1. verifySession throws a NON-JwtError (our code broke, not a bad token) →
//      must propagate to the error handler, NOT be swallowed into a 401, and NOT
//      clear the cookie (don't punish a possibly-valid session for our fault).
//   2. the prisma user lookup throws → same: propagate, don't clear.
// Both are mapped to a generic 500 by errorMiddleware with no internals leaked.
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
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  verifySession: vi.fn(),
}));

vi.mock('../db.js', () => ({
  prisma: { user: { findUnique: mocks.findUnique } },
}));

// Real JwtError class so requireAuth's `err instanceof JwtError` discrimination
// is genuine; verifySession is the controllable seam.
vi.mock('../lib/jwt.js', () => ({
  JwtError: class JwtError extends Error {
    override readonly name = 'JwtError';
  },
  verifySession: mocks.verifySession,
}));

const { requireAuth } = await import('./requireAuth.js');
const { errorMiddleware } = await import('../lib/errors.js');

const COOKIE_SECRET = process.env.COOKIE_SECRET!;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(COOKIE_SECRET));
  app.get('/auth-only', requireAuth, (req, res) => {
    res.status(200).json({ user: req.user });
  });
  app.use(errorMiddleware);
  return app;
}

/** Any non-empty token wrapped in cookie-parser's signed envelope (`s:<v>.<sig>`).
 *  verifySession is mocked, so the token CONTENT is irrelevant — it only needs to
 *  pass the signed-cookie layer so requireAuth proceeds to call verifySession. */
function signedCookie(token: string): string {
  const sig = createHmac('sha256', COOKIE_SECRET).update(token).digest('base64').replace(/=+$/, '');
  return `session=s:${token}.${sig}`;
}

function clearsSession(res: { headers: Record<string, unknown> }): boolean {
  const h = res.headers['set-cookie'];
  const joined = Array.isArray(h) ? h.join('\n') : String(h ?? '');
  return /^session=/m.test(joined) && /Expires=Thu, 01 Jan 1970/.test(joined);
}

beforeEach(() => {
  mocks.findUnique.mockReset();
  mocks.verifySession.mockReset();
});

describe('requireAuth — error propagation (not 401)', () => {
  it('propagates a NON-JwtError from verifySession as 500 and does NOT clear the cookie', async () => {
    mocks.verifySession.mockImplementation(() => {
      throw new TypeError('boom — our bug, not a bad token');
    });

    const res = await request(buildApp()).get('/auth-only').set('Cookie', [signedCookie('whatever')]);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'INTERNAL' });
    expect(clearsSession(res)).toBe(false); // a valid session isn't punished for our fault
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it('propagates a DB error from the user lookup as 500 and does NOT clear the cookie', async () => {
    mocks.verifySession.mockReturnValue({ sub: 'user_1' });
    mocks.findUnique.mockRejectedValue(new Error('db pool exhausted'));

    const res = await request(buildApp()).get('/auth-only').set('Cookie', [signedCookie('whatever')]);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'INTERNAL' });
    expect(clearsSession(res)).toBe(false);
    expect(mocks.findUnique).toHaveBeenCalledOnce();
  });
});
