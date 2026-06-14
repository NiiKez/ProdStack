// Boot-time claim recovery (queue.ts). Focuses on the cancellation-aware
// branch: a user-cancelled build that got SIGKILLed mid-flight before the
// runner's catch could record CANCELLED must be recovered as CANCELLED, not
// mislabeled FAILED.
process.env.NODE_ENV = 'test';
process.env.WEB_ORIGIN = 'http://localhost:5173';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.JWT_SECRET = 'test-jwt-secret-test-jwt-secret-test-jwt-secret';
process.env.COOKIE_SECRET = 'test-cookie-secret-test-cookie-secret-test-cookie';
process.env.DATA_ENC_KEY = Buffer.alloc(32, 9).toString('base64');
process.env.GITHUB_OAUTH_CLIENT_ID = 'test-client-id';
process.env.GITHUB_OAUTH_CLIENT_SECRET = 'test-client-secret';
process.env.GITHUB_OAUTH_CALLBACK_URL = 'http://localhost:3000/api/auth/github/callback';
process.env.AZURE_STUB = 'true';
process.env.LOG_LEVEL = 'silent';

import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ buildUpdateMany: vi.fn(), queryRaw: vi.fn() }));

vi.mock('../../db.js', () => ({
  prisma: { build: { updateMany: mocks.buildUpdateMany }, $queryRaw: mocks.queryRaw },
}));

const { claimNextBuild, failExhaustedBuilds, recoverOwnClaims } = await import('./queue.js');

interface WhereArg {
  status: unknown;
  cancelRequested?: boolean;
  isDemo?: boolean;
  claimedAt?: unknown;
  attempts?: unknown;
}
interface UpdateManyArg {
  where: WhereArg;
  data: { status?: string };
}

beforeEach(() => {
  mocks.buildUpdateMany.mockReset();
  mocks.queryRaw.mockReset();
});

describe('claimNextBuild', () => {
  it('excludes demo builds (isDemo = false) from the claim SELECT', async () => {
    // Defense-in-depth per docs/DEMO_MODE.md §4 layer 2: a pre-claimed demo
    // build is already invisible via `claimedAt IS NULL`, but the worker's claim
    // query must also carry the explicit `isDemo = false` guard.
    mocks.queryRaw.mockResolvedValue([]);
    await claimNextBuild('worker-1', 3);

    expect(mocks.queryRaw).toHaveBeenCalledTimes(1);
    const sql = mocks.queryRaw.mock.calls[0]![0] as Prisma.Sql;
    // The literal `"isDemo" = false` lives in the static SQL text (it's not a
    // parameterized value), so it appears in the joined query fragments.
    const text = sql.strings.join('');
    expect(text).toContain('"isDemo" = false');
    expect(text).toContain("status = 'QUEUED'");
    expect(text).toContain('"claimedAt" IS NULL');
  });

  it('caps re-claims with an attempts < maxAttempts guard (poison-pill)', async () => {
    // A build that keeps crashing the worker before it can record a terminal
    // status must not be re-claimed forever — claimNextBuild excludes any row
    // whose attempts have reached the cap. The cap is a bound *parameter*, so it
    // shows up as a SQL placeholder with `maxAttempts` in the values array.
    mocks.queryRaw.mockResolvedValue([]);
    await claimNextBuild('worker-1', 3);

    const sql = mocks.queryRaw.mock.calls[0]![0] as Prisma.Sql;
    expect(sql.strings.join('')).toContain('"attempts" <');
    // The worker id and the attempts cap are the two bound values.
    expect(sql.values).toContain(3);
  });
});

describe('failExhaustedBuilds', () => {
  it('marks unclaimed, non-demo QUEUED builds at/over the attempts cap as FAILED', async () => {
    mocks.buildUpdateMany.mockResolvedValue({ count: 2 });

    const reaped = await failExhaustedBuilds(3);
    expect(reaped).toBe(2);

    expect(mocks.buildUpdateMany).toHaveBeenCalledTimes(1);
    const arg = mocks.buildUpdateMany.mock.calls[0]![0] as UpdateManyArg & {
      where: WhereArg;
      data: { status?: string; errorMessage?: string };
    };
    // Only QUEUED + unclaimed + non-demo + attempts >= cap rows are reaped, and
    // they go terminal (FAILED) so the KEDA `builds-pending` count can drop to 0.
    expect(arg.where.status).toBe('QUEUED');
    expect(arg.where.claimedAt).toBeNull();
    expect(arg.where.isDemo).toBe(false);
    expect(arg.where.attempts).toEqual({ gte: 3 });
    expect(arg.data.status).toBe('FAILED');
    expect(arg.data.errorMessage).toMatch(/3 attempts/);
  });
});

describe('recoverOwnClaims', () => {
  it('recovers cancel-requested in-flight builds as CANCELLED and the rest as FAILED', async () => {
    mocks.buildUpdateMany
      .mockResolvedValueOnce({ count: 2 }) // released QUEUED rows
      .mockResolvedValueOnce({ count: 1 }) // cancelled in-flight rows
      .mockResolvedValueOnce({ count: 3 }); // failed in-flight rows

    const total = await recoverOwnClaims('worker-1', 60_000);
    expect(total).toBe(6);

    const calls = mocks.buildUpdateMany.mock.calls.map((c) => c[0] as UpdateManyArg);
    expect(calls).toHaveLength(3);

    // 1) Release stuck QUEUED claims.
    expect(calls[0]!.where.status).toBe('QUEUED');
    expect(calls[0]!.data).toMatchObject({ claimedAt: null, claimedBy: null });

    // 2) In-flight + cancelRequested → CANCELLED (never FAILED).
    expect(calls[1]!.where.cancelRequested).toBe(true);
    expect(calls[1]!.data.status).toBe('CANCELLED');

    // 3) In-flight + not cancelRequested → FAILED.
    expect(calls[2]!.where.cancelRequested).toBe(false);
    expect(calls[2]!.data.status).toBe('FAILED');

    // Every recovery query must exclude demo builds (§4 layer 2) so the boot
    // stale-reaper never flips an in-process-driven demo build to FAILED.
    for (const call of calls) {
      expect(call.where.isDemo).toBe(false);
    }
  });
});
