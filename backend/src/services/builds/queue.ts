/**
 * Postgres-backed build queue.
 *
 * One row in `Build` per queued job; `claimedAt`/`claimedBy` form an
 * exclusive lease taken atomically via `FOR UPDATE SKIP LOCKED`. Multiple
 * workers (or a single worker across restarts) can poll without ever
 * processing the same row twice.
 *
 * Status transitions are owned by the runner that holds the claim — this
 * module only deals with handing out / cleaning up claims.
 */
import { type BuildStatus, Prisma } from '@prisma/client';

import { prisma } from '../../db.js';

export interface ClaimedBuild {
  id: string;
  attempts: number;
}

/**
 * Atomically lease the oldest QUEUED+unclaimed build to `workerId`. Returns
 * `null` if the queue is empty. The chained `UPDATE … WHERE id = (SELECT …
 * FOR UPDATE SKIP LOCKED)` is the standard Postgres pattern: the inner
 * select holds a row lock that the outer update consumes, so the row is
 * invisible to other workers from the moment we pick it.
 */
export async function claimNextBuild(
  workerId: string,
  maxAttempts: number,
): Promise<ClaimedBuild | null> {
  const rows = await prisma.$queryRaw<Array<{ id: string; attempts: number }>>(Prisma.sql`
    UPDATE "Build"
    SET "claimedAt" = NOW(),
        "claimedBy" = ${workerId},
        "attempts"  = "attempts" + 1
    WHERE id = (
      SELECT id FROM "Build"
      -- Demo builds are created pre-claimed (claimedAt set) so the IS NULL guard
      -- already hides them; the explicit "isDemo" = false is defense-in-depth
      -- per docs/DEMO_MODE.md §4 layer 2 — a demo build can never be claimed by
      -- the real Kaniko worker even if its pre-claim were somehow released.
      --
      -- "attempts" < maxAttempts is the poison-pill cap: a build that has already
      -- been claimed maxAttempts times (each prior try crashed the worker before
      -- it could record a terminal status) is left for failExhaustedBuilds to
      -- mark FAILED rather than re-claimed into another crash loop.
      WHERE status = 'QUEUED'
        AND "claimedAt" IS NULL
        AND "isDemo" = false
        AND "attempts" < ${maxAttempts}
      ORDER BY "createdAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id, attempts
  `);
  return rows[0] ?? null;
}

/**
 * Fail any QUEUED build that has exhausted its claim budget (a poison pill that
 * keeps crashing the worker before it can record a terminal status). Without
 * this the row would sit QUEUED forever: `claimNextBuild`'s `attempts < max`
 * guard stops re-claiming it, but the KEDA `builds-pending` scale rule counts
 * QUEUED rows, so the (billed) builder would never scale back to zero. Marking
 * it FAILED both drains the queue and lets the builder idle down. Returns the
 * number of builds reaped. Scoped to unclaimed, non-demo rows.
 */
export async function failExhaustedBuilds(maxAttempts: number): Promise<number> {
  const reaped = await prisma.build.updateMany({
    where: {
      status: 'QUEUED',
      claimedAt: null,
      isDemo: false,
      attempts: { gte: maxAttempts },
    },
    data: {
      status: 'FAILED',
      finishedAt: new Date(),
      errorMessage: `build failed after ${maxAttempts} attempts (the worker kept crashing before it could finish)`,
    },
  });
  return reaped.count;
}

/**
 * Boot-time recovery. Handles two cases:
 *
 *  1. Claims this worker held before a crash (matched by `workerId`).
 *  2. Orphaned claims from a previous worker incarnation whose id we no
 *     longer match — e.g. the default `worker-<pid>` rotates each restart
 *     and the old PID is gone. We can't tell those apart from "another
 *     live worker is mid-build" by id alone, so we use age: anything
 *     claimed longer ago than the hard build timeout (plus headroom)
 *     cannot still be making progress.
 *
 * Builds that crashed mid-run (status past QUEUED) are marked FAILED so the
 * UI doesn't show "BUILDING" forever; if we left them at their last status,
 * the polling worker would skip them (only QUEUED is eligible). The one
 * exception: a build the user had asked to cancel (`cancelRequested`) that got
 * SIGKILLed by the build timeout / replica teardown before `runBuild`'s catch
 * could record CANCELLED is recovered as CANCELLED, not FAILED — otherwise a
 * user-cancelled build would be mislabeled a failure across the worker's
 * single-use restart.
 */
export async function recoverOwnClaims(
  workerId: string,
  staleAfterMs: number,
): Promise<number> {
  const staleBefore = new Date(Date.now() - staleAfterMs);
  const finishedAt = new Date();
  const inFlight: BuildStatus[] = ['CLONING', 'BUILDING', 'PUSHING', 'DEPLOYING'];
  // `isDemo: false` keeps the boot stale-reaper from ever flipping a demo build
  // to FAILED/CANCELLED — demo builds are driven in-process by the API, not the
  // worker, so they must be invisible to this recovery path. Defense-in-depth
  // per docs/DEMO_MODE.md §4 layer 2.
  const mine = {
    isDemo: false,
    OR: [{ claimedBy: workerId }, { claimedAt: { lt: staleBefore } }],
  };

  const released = await prisma.build.updateMany({
    where: { status: 'QUEUED', ...mine },
    data: { claimedAt: null, claimedBy: null },
  });
  const cancelled = await prisma.build.updateMany({
    where: { status: { in: inFlight }, cancelRequested: true, ...mine },
    data: {
      status: 'CANCELLED',
      errorMessage: 'cancelled by user',
      finishedAt,
    },
  });
  const failed = await prisma.build.updateMany({
    where: { status: { in: inFlight }, cancelRequested: false, ...mine },
    data: {
      status: 'FAILED',
      errorMessage: 'worker restarted mid-build',
      finishedAt,
    },
  });
  return released.count + cancelled.count + failed.count;
}
