// Set env before any module under test imports `env.ts` (parses + exits on
// invalid env at module load).
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

const COOKIE_SECRET = process.env.COOKIE_SECRET!;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(COOKIE_SECRET));
  app.get('/auth-only', requireAuth, (req, res) => {
    res.status(200).json({ user: req.user });
  });
  return app;
}

function signedSessionCookie(userId: string): string {
  // Production signer → token carries the iss/aud verifySession now requires.
  const token = signSession(userId);
  return `session=s:${signCookieValue(token, COOKIE_SECRET)}`;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('requireAuth — expired demo session', () => {
  it('returns 401 and clears the session cookie when a demo user is past demoExpiresAt', async () => {
    const app = buildApp();
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'demo_1',
      githubLogin: 'demo-abc123',
      email: null,
      avatarUrl: null,
      isDemo: true,
      // One hour in the PAST.
      demoExpiresAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    const res = await request(app)
      .get('/auth-only')
      .set('Cookie', [signedSessionCookie('demo_1')]);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'UNAUTHORIZED' });

    // The stale demo cookie is cleared so the client stops resending it.
    const setCookie = res.headers['set-cookie'];
    const cookieHeader = Array.isArray(setCookie) ? setCookie.join('\n') : (setCookie ?? '');
    expect(cookieHeader).toMatch(/^session=/m);
    expect(cookieHeader).toMatch(/Expires=Thu, 01 Jan 1970/);
  });

  it('returns 401 and clears the session cookie when a demo user has a null demoExpiresAt (malformed)', async () => {
    const app = buildApp();
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'demo_null',
      githubLogin: 'demo-null789',
      email: null,
      avatarUrl: null,
      isDemo: true,
      // Malformed: demo-login always sets a TTL, and the reaper keys off it, so a
      // null demoExpiresAt is a never-expiring, never-reaped demo session — must
      // fail closed exactly like a past-TTL one.
      demoExpiresAt: null,
    });

    const res = await request(app)
      .get('/auth-only')
      .set('Cookie', [signedSessionCookie('demo_null')]);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'UNAUTHORIZED' });

    // The malformed demo cookie is cleared so the client stops resending it.
    const setCookie = res.headers['set-cookie'];
    const cookieHeader = Array.isArray(setCookie) ? setCookie.join('\n') : (setCookie ?? '');
    expect(cookieHeader).toMatch(/^session=/m);
    expect(cookieHeader).toMatch(/Expires=Thu, 01 Jan 1970/);
  });

  it('fails closed at the EXACT boundary (demoExpiresAt === now → 401, pinning the <= not <)', async () => {
    // Invoke requireAuth directly with a pinned clock so demoExpiresAt.getTime()
    // equals Date.now() to the millisecond — a `< now` check would (wrongly) let
    // this through; the `<= now` in requireAuth must reject it.
    const now = 1_700_000_000_000;
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'demo_boundary',
        githubLogin: 'demo-edge',
        email: null,
        avatarUrl: null,
        isDemo: true,
        demoExpiresAt: new Date(now), // exactly now
      });

      const req = { signedCookies: { session: signSession('demo_boundary') } } as never;
      const res = {
        statusCode: 0,
        body: null as unknown,
        status(n: number) {
          this.statusCode = n;
          return this;
        },
        json(b: unknown) {
          this.body = b;
          return this;
        },
        clearCookie: vi.fn(),
      };
      const next = vi.fn();

      await requireAuth(req, res as never, next as never);

      expect(res.statusCode).toBe(401);
      expect(res.body).toEqual({ error: 'UNAUTHORIZED' });
      expect(res.clearCookie).toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
    } finally {
      dateNow.mockRestore();
    }
  });

  it('still authenticates a demo user whose demoExpiresAt is in the FUTURE', async () => {
    const app = buildApp();
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'demo_2',
      githubLogin: 'demo-def456',
      email: null,
      avatarUrl: null,
      isDemo: true,
      demoExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const res = await request(app)
      .get('/auth-only')
      .set('Cookie', [signedSessionCookie('demo_2')]);

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: 'demo_2', isDemo: true });
  });
});

// --- helpers ---------------------------------------------------------------

/** Replicates `cookie-signature.sign(value, secret)` (s:<value>.<sig>). */
function signCookieValue(value: string, secret: string): string {
  const sig = createHmac('sha256', secret)
    .update(value)
    .digest('base64')
    .replace(/=+$/, '');
  return `${value}.${sig}`;
}
