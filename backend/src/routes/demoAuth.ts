import { randomBytes, randomInt } from 'node:crypto';

import { Prisma } from '@prisma/client';
import { Router, type NextFunction, type Request, type Response } from 'express';

import { prisma } from '../db.js';
import { env } from '../env.js';
import { setSessionCookie } from '../lib/cookies.js';
import { encrypt } from '../lib/crypto.js';
import { signSession } from '../lib/jwt.js';
import { isSafeNextPath } from '../lib/safeNext.js';
import { demoLoginLimiter } from '../middleware/rateLimit.js';
import { seedDemoWorkspace } from '../services/demo/demoOrchestrator.js';

/**
 * Demo-login router — mounted by `app.ts` under `/api/auth` (so it inherits the
 * central `requireXRequestedWith` CSRF gate; GET is exempt, so `GET /demo-login`
 * passes). See docs/DEMO_MODE.md §6.1.
 *
 *   GET /api/auth/demo-login
 *
 * Mints an ephemeral, sandboxed demo `User` (no GitHub needed), seeds a fake
 * workspace, sets the same signed-JWT session cookie real users get, and
 * redirects into the dashboard. The WHOLE surface is invisible (404) unless
 * `ENABLE_DEMO=true`, and is capacity-capped + rate-limited.
 *
 * Production-safe analogue of the (removed, dev-only) `devAuth.ts` backdoor: it
 * never bypasses the demo capacity/TTL controls and its synthetic `githubUserId`
 * is drawn from a reserved NEGATIVE band so it can never collide with a real
 * (positive) GitHub id. The placeholder OAuth token is never used for a real
 * GitHub call — demo writes route through the demo orchestrator (DB-only).
 */

const router = Router();

/** How long the 503 "at capacity" response asks the client to wait (seconds). */
const CAPACITY_RETRY_AFTER_SECONDS = 300;

/** Max collision-retries when picking a synthetic negative githubUserId. */
const GITHUB_ID_RETRIES = 5;

/**
 * Stable advisory-lock id for the demo-capacity critical section. Any concurrent
 * demo-login serializes on this single key while it checks the cap and inserts,
 * so the count→insert below is atomic across requests (see {@link admitDemoUser}).
 */
const DEMO_CAP_LOCK_KEY = 728_412;

/** Internal signal: the active-demo-user count was at DEMO_MAX_ACTIVE. */
class DemoAtCapacityError extends Error {}

/** Reserved negative band for synthetic demo githubUserIds: `-1 … -2_000_000_000`.
 *  Real GitHub ids are positive, so this band can never collide with one. Uses
 *  `crypto.randomInt` (CSPRNG) rather than `Math.random()`: the id only needs to
 *  be unique, not unpredictable, but a CSPRNG keeps it off the "insecure
 *  randomness in a security context" radar at zero cost (`randomInt(2e9)` is well
 *  under the 2^48 ceiling and synchronous). */
function randomDemoGithubUserId(): number {
  return -(randomInt(2_000_000_000) + 1);
}

/**
 * Layer-4 env gate (docs/DEMO_MODE.md §4), mounted BEFORE the rate limiter so a
 * disabled surface is byte-identical to a genuinely nonexistent route: it 404s
 * with NO `RateLimit-*` headers and no limiter side effects, so a probe can't
 * even tell the route is mounted. (Previously the limiter ran first and emitted
 * standard rate-limit headers ahead of the 404 — a faint route-existence oracle.)
 */
function requireDemoEnabled(_req: Request, res: Response, next: NextFunction): void {
  if (!env.ENABLE_DEMO) {
    res.status(404).json({ error: 'NOT_FOUND' });
    return;
  }
  next();
}

router.get('/demo-login', requireDemoEnabled, demoLoginLimiter, async (req: Request, res, next) => {
  try {
    // Capacity cap: refuse new sessions once the live (unexpired) demo-user
    // count hits DEMO_MAX_ACTIVE, so a flood of sandboxes can't balloon the DB.
    let user: { id: string };
    try {
      user = await admitDemoUser();
    } catch (err) {
      if (err instanceof DemoAtCapacityError) {
        res.setHeader('Retry-After', String(CAPACITY_RETRY_AFTER_SECONDS));
        res.status(503).json({
          error: 'DEMO_AT_CAPACITY',
          message: 'Demo is at capacity, try again shortly.',
        });
        return;
      }
      throw err;
    }

    // Seed the sandbox AFTER the user row is committed (and the cap lock released)
    // so the dashboard isn't empty. DB-only (orchestrator never touches
    // Azure/ACR/git/Kaniko).
    //
    // The user row is already committed at this point, so a seed failure would
    // otherwise leave an empty orphan user consuming a DEMO_MAX_ACTIVE slot until
    // its TTL/the reaper. Compensate: best-effort delete the just-created user
    // (cascade-purges any partial seed) before surfacing the error, so a failed
    // seed never permanently burns capacity.
    try {
      await seedDemoWorkspace(user.id);
    } catch (seedErr) {
      await prisma.user.delete({ where: { id: user.id } }).catch(() => {
        // Best-effort: if the compensating delete also fails, the TTL/reaper
        // still reclaims the slot — we just surface the original seed error.
      });
      throw seedErr;
    }

    setSessionCookie(res, signSession(user.id));
    res.redirect(302, resolveNext(req));
  } catch (err) {
    next(err);
  }
});

/**
 * Atomically admit one demo `User`, enforcing DEMO_MAX_ACTIVE without a TOCTOU
 * race. The cap check and the insert run inside ONE transaction guarded by a
 * Postgres advisory lock (`pg_advisory_xact_lock`), so N concurrent demo-logins
 * can't all read `count < max` and all insert past the ceiling — they serialize
 * on the lock, which auto-releases at commit. The lock spans only the fast
 * count+insert; the slow workspace seed runs AFTER, outside the transaction.
 *
 * Throws {@link DemoAtCapacityError} when the live (unexpired) demo-user count is
 * already at the cap. Retries the WHOLE transaction on a P2002 unique-constraint
 * collision on the synthetic `githubUserId` (a Postgres error aborts the
 * surrounding transaction, so we can't retry the insert in place — we re-roll a
 * fresh reserved-band id and re-run), mirroring the prior collision handling.
 */
async function admitDemoUser(): Promise<{ id: string }> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < GITHUB_ID_RETRIES; attempt++) {
    // Placeholder ciphertext — never used for a real GitHub call; the token
    // columns are non-null `Bytes`, so a demo user still needs *a* value.
    const tok = encrypt('demo-no-github-token');
    try {
      return await prisma.$transaction(async (tx) => {
        // Serialize the cap critical section across all concurrent logins.
        // MUST be `$executeRaw`, not `$queryRaw`: `pg_advisory_xact_lock` returns
        // a `void` column, and Prisma's `$queryRaw` deserializer throws P2010
        // ("Failed to deserialize column of type 'void'") on it. `$executeRaw`
        // runs the statement (acquiring the lock) without deserializing the
        // result column, so it sidesteps the void entirely.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${DEMO_CAP_LOCK_KEY}::bigint)`;
        const activeDemoUsers = await tx.user.count({
          where: { isDemo: true, demoExpiresAt: { gt: new Date() } },
        });
        if (activeDemoUsers >= env.DEMO_MAX_ACTIVE) {
          throw new DemoAtCapacityError();
        }
        return await tx.user.create({
          data: {
            githubUserId: randomDemoGithubUserId(),
            githubLogin: `demo-${randomBytes(3).toString('hex')}`,
            email: null,
            avatarUrl: null,
            isDemo: true,
            demoExpiresAt: new Date(Date.now() + env.DEMO_TTL_MINUTES * 60_000),
            githubTokenCiphertext: tok.ciphertext,
            githubTokenIv: tok.iv,
            githubTokenAuthTag: tok.authTag,
            githubTokenKeyVersion: tok.keyVersion,
          },
          select: { id: true },
        });
      });
    } catch (err) {
      if (err instanceof DemoAtCapacityError) throw err;
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  throw lastErr ?? new Error('failed to allocate a unique demo githubUserId');
}

/**
 * Honour an optional safe `?next=` path (the shared {@link isSafeNextPath}
 * validation auth.ts also uses), defaulting to `/dashboard`. Rejects
 * protocol-relative / off-site / whitespace-bearing values so the redirect
 * can't be hijacked.
 */
function resolveNext(req: Request): string {
  const raw = req.query.next;
  if (typeof raw === 'string' && isSafeNextPath(raw)) {
    return raw;
  }
  return '/dashboard';
}

export default router;
