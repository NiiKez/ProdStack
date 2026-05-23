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
import { Prisma } from '@prisma/client';

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
export async function claimNextBuild(workerId: string): Promise<ClaimedBuild | null> {
  const rows = await prisma.$queryRaw<Array<{ id: string; attempts: number }>>(Prisma.sql`
    UPDATE "Build"
    SET "claimedAt" = NOW(),
        "claimedBy" = ${workerId},
        "attempts"  = "attempts" + 1
    WHERE id = (
      SELECT id FROM "Build"
      WHERE status = 'QUEUED' AND "claimedAt" IS NULL
      ORDER BY "createdAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id, attempts
  `);
  return rows[0] ?? null;
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
 * the polling worker would skip them (only QUEUED is eligible).
 */
export async function recoverOwnClaims(
  workerId: string,
  staleAfterMs: number,
): Promise<number> {
  const staleBefore = new Date(Date.now() - staleAfterMs);

  const released = await prisma.build.updateMany({
    where: {
      status: 'QUEUED',
      OR: [{ claimedBy: workerId }, { claimedAt: { lt: staleBefore } }],
    },
    data: { claimedAt: null, claimedBy: null },
  });
  const failed = await prisma.build.updateMany({
    where: {
      status: { in: ['CLONING', 'BUILDING', 'PUSHING', 'DEPLOYING'] },
      OR: [{ claimedBy: workerId }, { claimedAt: { lt: staleBefore } }],
    },
    data: {
      status: 'FAILED',
      errorMessage: 'worker restarted mid-build',
      finishedAt: new Date(),
    },
  });
  return released.count + failed.count;
}
