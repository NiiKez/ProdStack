/**
 * Postgres build/log pruning (M6 §2.14).
 *
 * The build log volume is the main DB growth driver: every build writes
 * potentially thousands of `LogLine` rows. This daily job keeps the database
 * (Burstable B1ms, 32 GiB) from bloating by deleting:
 *
 *   1. `LogLine` rows older than RETENTION_DAYS_LOGS (by their `ts` column).
 *   2. Terminal `Build` rows older than RETENTION_DAYS_BUILDS. "Terminal" =
 *      READY / FAILED / CANCELLED — an in-flight build (QUEUED / CLONING /
 *      BUILDING / PUSHING / DEPLOYING) is never reaped regardless of age.
 *      Cascade deletes (schema `onDelete: Cascade`) remove a deleted build's
 *      remaining LogLines and Deployments automatically.
 *
 *      ⚠️ A build that still backs ANY Deployment row is NEVER reaped, no matter
 *      how old (`deployments: { none: {} }`). This is load-bearing: the
 *      `Deployment.build` FK is `onDelete: Cascade`, so deleting a >90d terminal
 *      build that is the ACTIVE deployment of an idle "deploy-once, leave-running"
 *      project would cascade-delete that active Deployment row — silently losing
 *      the DB record of what is live (breaking env-save redeploy, rollback, and
 *      the activity/deployments UI, which all read `deployment.active = true`).
 *      Protecting every referenced build also preserves deployment history +
 *      rollback targets. Builds never deployed (failed / superseded) still prune.
 *      Tradeoff: deployed-build rows accumulate over a project's lifetime, but
 *      that count is bounded by deployment events (tiny vs. the LogLine volume
 *      this job actually exists to cap, and logs still prune at 30d regardless).
 *
 * Batching: each delete is a single time-windowed `deleteMany`. The `ts`/`createdAt`
 * predicate IS the batching boundary — it bounds the working set to "older than
 * the cutoff", which on a daily cadence is at most one day's worth of newly-aged
 * rows, so there's no unbounded full-table lock. (A true id-chunked loop is
 * overkill for this volume; the time predicate keeps each statement small.)
 */
import type { BuildStatus } from '@prisma/client';

import { prisma } from '../../db.js';
import { env } from '../../env.js';
import { logger } from '../../lib/logger.js';

const log = logger.child({ component: 'cleanup-builds' });

/** Build statuses safe to delete — a build in any of these has finished. */
const TERMINAL_STATUSES: BuildStatus[] = ['READY', 'FAILED', 'CANCELLED'];

const DAY_MS = 24 * 60 * 60 * 1000;

export interface CleanupBuildsResult {
  logLinesDeleted: number;
  buildsDeleted: number;
}

export async function cleanupBuilds(): Promise<CleanupBuildsResult> {
  const now = Date.now();
  const logsCutoff = new Date(now - env.RETENTION_DAYS_LOGS * DAY_MS);
  const buildsCutoff = new Date(now - env.RETENTION_DAYS_BUILDS * DAY_MS);

  // 1. Old log lines. Time-windowed by `ts`.
  const logDelete = await prisma.logLine.deleteMany({
    where: { ts: { lt: logsCutoff } },
  });

  // 2. Old terminal builds NOT referenced by any Deployment. Cascades to their
  //    remaining LogLines. `deployments: { none: {} }` is the data-loss guard —
  //    see the header note: never reap a build that backs a (possibly active)
  //    deployment, or its onDelete:Cascade would take the live Deployment with it.
  const buildDelete = await prisma.build.deleteMany({
    where: {
      status: { in: TERMINAL_STATUSES },
      createdAt: { lt: buildsCutoff },
      deployments: { none: {} },
    },
  });

  const result: CleanupBuildsResult = {
    logLinesDeleted: logDelete.count,
    buildsDeleted: buildDelete.count,
  };

  log.info(
    {
      logLinesDeleted: result.logLinesDeleted,
      buildsDeleted: result.buildsDeleted,
      retentionDaysLogs: env.RETENTION_DAYS_LOGS,
      retentionDaysBuilds: env.RETENTION_DAYS_BUILDS,
    },
    'build/log cleanup complete',
  );
  return result;
}
