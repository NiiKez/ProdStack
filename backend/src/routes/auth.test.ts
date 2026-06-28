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
process.env.LOG_LEVEL = 'silent';

import { createHmac } from 'node:crypto';

import cookieParser from 'cookie-parser';
import express from 'express';
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
    securityEvent: { create: vi.fn() },
  },
}));

vi.mock('../services/github.js', () => ({
  exchangeCodeForToken: vi.fn(),
  fetchGithubProfile: vi.fn(),
  octokitForUser: vi.fn(),
  GithubAuthError: class GithubAuthError extends Error {},
}));

import { prisma } from '../db.js';
import { signSession } from '../lib/jwt.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireXRequestedWith } from '../middleware/requireXRequestedWith.js';
import { exchangeCodeForToken, fetchGithubProfile } from '../services/github.js';
import authRouter from './auth.js';

const COOKIE_SECRET = process.env.COOKIE_SECRET!;

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

  it('records an auth.oauth_state_mismatch audit event without capturing the code/state values', async () => {
    const app = buildApp();
    const signedState = signCookieValue('cookie-state', COOKIE_SECRET);

    const res = await request(app)
      .get('/api/auth/github/callback')
      .query({ code: 'SECRETCODE123', state: 'SECRETSTATE456' })
      .set('Cookie', [`oauth_state=s:${signedState}`]);

    expect(res.status).toBe(400);

    const createMock = prisma.securityEvent.create as ReturnType<typeof vi.fn>;
    expect(createMock).toHaveBeenCalledTimes(1);
    const data = createMock.mock.calls[0]![0]!.data;
    expect(data).toMatchObject({
      action: 'auth.oauth_state_mismatch',
      outcome: 'failure',
      // CSRF/replay guard tripped: the query state didn't match the signed cookie.
      metadata: { reason: 'state_mismatch' },
    });
    // The OAuth code + state must never be captured in the audit row.
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain('SECRETCODE123');
    expect(serialized).not.toContain('SECRETSTATE456');
  });
});

describe('GET /api/auth/github/callback — state is single-use', () => {
  const mockExchange = exchangeCodeForToken as ReturnType<typeof vi.fn>;
  const mockProfile = fetchGithubProfile as ReturnType<typeof vi.fn>;
  const mockUpsert = prisma.user.upsert as ReturnType<typeof vi.fn>;

  function joinSetCookie(res: { headers: Record<string, unknown> }): string {
    const h = res.headers['set-cookie'];
    return Array.isArray(h) ? h.join('\n') : String(h ?? '');
  }

  it('clears the oauth_state cookie on a successful callback so it cannot be replayed', async () => {
    mockExchange.mockResolvedValue({ accessToken: 'gho_token' });
    mockProfile.mockResolvedValue({
      id: 4242,
      login: 'octocat',
      email: 'octo@example.com',
      avatarUrl: 'https://example.com/a.png',
    });
    mockUpsert.mockResolvedValue({ id: 'user_1' });

    const signedState = signCookieValue('state-abc', COOKIE_SECRET);
    const res = await request(buildApp())
      .get('/api/auth/github/callback')
      .query({ code: 'code-1', state: 'state-abc' })
      .set('Cookie', [`oauth_state=s:${signedState}`])
      .redirects(0);

    expect(res.status).toBe(302);
    const cookies = joinSetCookie(res);
    // A fresh session was minted...
    expect(cookies).toMatch(/^session=/m);
    // ...and the single-use state cookie was expired.
    expect(cookies).toMatch(/^oauth_state=.*Expires=Thu, 01 Jan 1970/m);
  });

  it('clears oauth_state even when the token exchange fails (cleared BEFORE the exchange)', async () => {
    mockExchange.mockRejectedValue(new Error('github exchange down'));

    const signedState = signCookieValue('state-xyz', COOKIE_SECRET);
    const res = await request(buildApp())
      .get('/api/auth/github/callback')
      .query({ code: 'code-1', state: 'state-xyz' })
      .set('Cookie', [`oauth_state=s:${signedState}`])
      .redirects(0);

    const cookies = joinSetCookie(res);
    // The state nonce is invalidated regardless of the exchange outcome, so a
    // captured (code, state, cookie) triple can't be retried.
    expect(cookies).toMatch(/^oauth_state=.*Expires=Thu, 01 Jan 1970/m);
    // No session is minted on the failure path.
    expect(cookies).not.toMatch(/^session=/m);
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});

describe('GET /api/auth/github/begin — ?next handling', () => {
  function setCookieHeader(res: { headers: Record<string, unknown> }): string {
    const h = res.headers['set-cookie'];
    return Array.isArray(h) ? h.join('\n') : String(h ?? '');
  }

  it('redirects to GitHub and stores a SAFE next as a signed oauth_next cookie', async () => {
    const res = await request(buildApp())
      .get('/api/auth/github/begin')
      .query({ next: '/projects' })
      .redirects(0);

    expect(res.status).toBe(302);
    expect(String(res.headers.location)).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize\?/);
    const cookies = setCookieHeader(res);
    // oauth_next was set (signed → value is URL-encoded, `s:` → `s%3A`) and NOT expired.
    expect(cookies).toMatch(/^oauth_next=s%3A/m);
    expect(cookies).not.toMatch(/^oauth_next=.*Expires=Thu, 01 Jan 1970/m);
  });

  it('does NOT store an UNSAFE (off-origin) next — and clears any stale one', async () => {
    for (const next of ['//evil.com', 'https://evil.com', '/\\evil.com']) {
      const res = await request(buildApp())
        .get('/api/auth/github/begin')
        .query({ next })
        .redirects(0);
      expect(res.status).toBe(302);
      const cookies = setCookieHeader(res);
      // oauth_next is emitted only as an expiring clear (a signed-empty value),
      // and the off-site host never lands in ANY cookie value.
      expect(cookies, next).toMatch(/^oauth_next=.*Expires=Thu, 01 Jan 1970/m);
      expect(cookies.toLowerCase(), next).not.toContain('evil');
    }
  });

  it('clears a stale oauth_next when a fresh begin carries no next', async () => {
    const res = await request(buildApp()).get('/api/auth/github/begin').redirects(0);
    expect(res.status).toBe(302);
    // A bare begin must not inherit an earlier ?next= — it emits an expiring
    // oauth_next so a prior value can't survive into this login's callback.
    expect(setCookieHeader(res)).toMatch(/^oauth_next=.*Expires=Thu, 01 Jan 1970/m);
  });
});

describe('GET /api/auth/github/callback — safe ?next round-trip', () => {
  it('redirects to WEB_ORIGIN + the stored safe next path', async () => {
    (exchangeCodeForToken as ReturnType<typeof vi.fn>).mockResolvedValue({ accessToken: 'gho_x' });
    (fetchGithubProfile as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 4242,
      login: 'octocat',
      email: null,
      avatarUrl: null,
    });
    (prisma.user.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'user_1' });

    const signedState = signCookieValue('state-abc', COOKIE_SECRET);
    const signedNext = signCookieValue('/projects?tab=builds', COOKIE_SECRET);
    const res = await request(buildApp())
      .get('/api/auth/github/callback')
      .query({ code: 'code-1', state: 'state-abc' })
      .set('Cookie', [`oauth_state=s:${signedState}`, `oauth_next=s:${signedNext}`])
      .redirects(0);

    expect(res.status).toBe(302);
    // Lands back on our own origin at the requested path — never off-site.
    expect(res.headers.location).toBe('http://localhost:5173/projects?tab=builds');
  });
});

describe('OWNER_GITHUB_ID gate — unset (self-host default)', () => {
  it('lets ANY GitHub user through and persists their session when the gate is unset', async () => {
    // This suite never sets process.env.OWNER_GITHUB_ID, so the single-user gate
    // is a no-op — the documented open-source/self-host behavior (auth.ts).
    (exchangeCodeForToken as ReturnType<typeof vi.fn>).mockResolvedValue({ accessToken: 'gho_x' });
    (fetchGithubProfile as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 999, // not any "owner" — would be bounced if a gate were configured
      login: 'random-dev',
      email: null,
      avatarUrl: null,
    });
    const upsert = prisma.user.upsert as ReturnType<typeof vi.fn>;
    upsert.mockResolvedValue({ id: 'user_random' });

    const signedState = signCookieValue('state-1', COOKIE_SECRET);
    const res = await request(buildApp())
      .get('/api/auth/github/callback')
      .query({ code: 'c', state: 'state-1' })
      .set('Cookie', [`oauth_state=s:${signedState}`])
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('http://localhost:5173/dashboard');
    expect(upsert).toHaveBeenCalledTimes(1);
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

    // Use the production signer so the token carries the iss/aud the verifier
    // now requires — hand-rolling jwt.sign here would drift from prod.
    const token = signSession(fakeUser.id);
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

    const token = signSession(fakeUser.id);
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

    const token = signSession(demoUser.id);
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
