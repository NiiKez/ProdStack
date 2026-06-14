// Covers the ENABLED demo surface (ENABLE_DEMO=true). The disabled (404) case
// lives in demoAuth.disabled.test.ts.
//
// `env.ts` parses + FREEZES process.env at module load, and ESM hoists `import`
// statements above any top-level `process.env.X = …` assignment — so a plain
// top-level assignment would run AFTER env.ts already froze. We therefore set
// the env in a `vi.hoisted` block (vitest hoists it above every import) and
// dynamically `await import()` the router, mirroring me.test.ts's pattern.
import { Prisma } from '@prisma/client';
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
  process.env.ENABLE_DEMO = 'true';
  process.env.DEMO_TTL_MINUTES = '120';
  process.env.DEMO_MAX_ACTIVE = '50';
});

const mocks = vi.hoisted(() => ({
  userCount: vi.fn(),
  userCreate: vi.fn(),
  userDelete: vi.fn(),
  txQueryRaw: vi.fn(),
  $transaction: vi.fn(),
  seedDemoWorkspace: vi.fn(),
}));

// Interactive-transaction client: the cap critical section acquires the advisory
// lock then runs count + create on this same client (so they're one transaction).
const txClient = {
  $queryRaw: mocks.txQueryRaw,
  user: { count: mocks.userCount, create: mocks.userCreate },
};

vi.mock('../db.js', () => ({
  prisma: {
    $transaction: mocks.$transaction,
    user: { delete: mocks.userDelete },
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
  // Mirror app.ts: demo-login sits behind the central CSRF gate (GET is exempt).
  app.use('/api/auth', requireXRequestedWith, demoAuthRouter);
  return app;
}

beforeEach(() => {
  mocks.userCount.mockReset();
  mocks.userCreate.mockReset();
  mocks.userDelete.mockReset();
  mocks.txQueryRaw.mockReset();
  mocks.$transaction.mockReset();
  mocks.seedDemoWorkspace.mockReset();

  mocks.userCount.mockResolvedValue(0);
  mocks.userCreate.mockResolvedValue({ id: 'demo_user_1' });
  mocks.userDelete.mockResolvedValue({ id: 'demo_user_1' });
  mocks.txQueryRaw.mockResolvedValue([]);
  // Run the interactive-transaction callback against the shared tx client so the
  // cap-check + insert (and their thrown DemoAtCapacityError) propagate exactly
  // as they would against Postgres.
  mocks.$transaction.mockImplementation(async (fn: (tx: typeof txClient) => Promise<unknown>) =>
    fn(txClient),
  );
  mocks.seedDemoWorkspace.mockResolvedValue(undefined);
});

describe('GET /api/auth/demo-login (ENABLE_DEMO=true)', () => {
  it('mints a demo user, seeds the workspace, sets a session cookie, redirects to /dashboard', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/auth/demo-login').redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/dashboard');

    // A demo user was created with the documented invariants.
    expect(mocks.userCreate).toHaveBeenCalledTimes(1);
    const createArg = mocks.userCreate.mock.calls[0]![0] as {
      data: { isDemo: boolean; githubUserId: number; demoExpiresAt: Date; email: null; avatarUrl: null };
    };
    expect(createArg.data.isDemo).toBe(true);
    // Synthetic id is from the reserved NEGATIVE band — never collides with a
    // real (positive) GitHub id.
    expect(createArg.data.githubUserId).toBeLessThan(0);
    expect(createArg.data.email).toBeNull();
    expect(createArg.data.avatarUrl).toBeNull();
    // TTL is in the future.
    expect(createArg.data.demoExpiresAt.getTime()).toBeGreaterThan(Date.now());

    // Workspace seeded with the NEW user id, after the row is committed.
    expect(mocks.seedDemoWorkspace).toHaveBeenCalledTimes(1);
    expect(mocks.seedDemoWorkspace).toHaveBeenCalledWith('demo_user_1');

    // A signed session cookie was set.
    const setCookie = res.headers['set-cookie'];
    const cookieHeader = Array.isArray(setCookie) ? setCookie.join('\n') : (setCookie ?? '');
    expect(cookieHeader).toMatch(/^session=/m);
  });

  it('returns 503 DEMO_AT_CAPACITY (and creates no user) when the active demo count is at the cap', async () => {
    mocks.userCount.mockResolvedValueOnce(50); // == DEMO_MAX_ACTIVE
    const app = buildApp();
    const res = await request(app).get('/api/auth/demo-login').redirects(0);

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: 'DEMO_AT_CAPACITY' });
    expect(res.headers['retry-after']).toBe('300');
    expect(mocks.userCreate).not.toHaveBeenCalled();
    expect(mocks.seedDemoWorkspace).not.toHaveBeenCalled();
  });

  it('counts only UNEXPIRED demo users toward the capacity cap', async () => {
    const app = buildApp();
    await request(app).get('/api/auth/demo-login').redirects(0);
    expect(mocks.userCount).toHaveBeenCalledWith({
      where: { isDemo: true, demoExpiresAt: { gt: expect.any(Date) } },
    });
  });

  it('runs the cap-check + insert in ONE advisory-locked transaction (atomic, no TOCTOU)', async () => {
    // The cap is only meaningful if count→insert is atomic; otherwise N parallel
    // logins all read count<max and all insert past the ceiling. We enforce it
    // with a pg advisory lock inside a single interactive transaction.
    const app = buildApp();
    const res = await request(app).get('/api/auth/demo-login').redirects(0);
    expect(res.status).toBe(302);

    // Exactly one interactive transaction wrapped the cap-check + insert...
    expect(mocks.$transaction).toHaveBeenCalledTimes(1);
    // ...and a pg_advisory_xact_lock was acquired inside it (before count/create).
    expect(mocks.txQueryRaw).toHaveBeenCalledTimes(1);
    const lockSql = (mocks.txQueryRaw.mock.calls[0]![0] as readonly string[]).join('');
    expect(lockSql).toMatch(/pg_advisory_xact_lock/);
  });

  it('retries on a P2002 githubUserId collision, re-rolling a fresh reserved-band id', async () => {
    // First insert collides on the synthetic negative githubUserId; the retry
    // re-rolls a new one and succeeds. Proves the reserved-band-collision guard
    // the §10 checklist calls out ("synthetic githubUserId can't collide").
    mocks.userCreate
      .mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      )
      .mockResolvedValueOnce({ id: 'demo_user_1' });

    const app = buildApp();
    const res = await request(app).get('/api/auth/demo-login').redirects(0);

    expect(res.status).toBe(302);
    expect(mocks.userCreate).toHaveBeenCalledTimes(2);
    const first = mocks.userCreate.mock.calls[0]![0].data.githubUserId as number;
    const second = mocks.userCreate.mock.calls[1]![0].data.githubUserId as number;
    expect(first).toBeLessThan(0);
    expect(second).toBeLessThan(0);
    expect(second).not.toBe(first); // a fresh id was rolled
  });

  it('surfaces a non-P2002 create error (no infinite retry)', async () => {
    mocks.userCreate.mockRejectedValue(new Error('db down'));
    const app = buildApp();
    const res = await request(app).get('/api/auth/demo-login').redirects(0);
    expect(res.status).toBe(500);
    expect(mocks.userCreate).toHaveBeenCalledTimes(1);
  });

  it('deletes the just-created demo user when seeding fails (no leaked capacity slot)', async () => {
    // The user row is committed before the seed runs; a seed failure must not
    // leave an empty orphan consuming a DEMO_MAX_ACTIVE slot until TTL/reaper.
    mocks.seedDemoWorkspace.mockRejectedValueOnce(new Error('seed boom'));

    const app = buildApp();
    const res = await request(app).get('/api/auth/demo-login').redirects(0);

    expect(res.status).toBe(500);
    expect(mocks.userCreate).toHaveBeenCalledTimes(1);
    // Compensating delete of the exact user that was created.
    expect(mocks.userDelete).toHaveBeenCalledWith({ where: { id: 'demo_user_1' } });
    // No session cookie is minted when the workspace never seeded.
    const setCookie = res.headers['set-cookie'];
    const cookieHeader = Array.isArray(setCookie) ? setCookie.join('\n') : (setCookie ?? '');
    expect(cookieHeader).not.toMatch(/^session=/m);
  });

  it('still surfaces the seed error even if the compensating delete also fails', async () => {
    mocks.seedDemoWorkspace.mockRejectedValueOnce(new Error('seed boom'));
    mocks.userDelete.mockRejectedValueOnce(new Error('delete also down'));

    const app = buildApp();
    const res = await request(app).get('/api/auth/demo-login').redirects(0);

    // Best-effort cleanup: a failed delete is swallowed; the original seed error
    // still surfaces (the TTL/reaper reclaims the slot later).
    expect(res.status).toBe(500);
    expect(mocks.userDelete).toHaveBeenCalledTimes(1);
  });
});
