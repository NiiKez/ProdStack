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
 * Batching: the `Build` prune is low-volume (bounded by deployment events) and
 * stays a single time-windowed `deleteMany`. The `LogLine` prune is NOT — on a
 * backlog (e.g. a missed run, or a burst of chatty builds) the >30d set can be
 * millions of rows, and a single unbounded `deleteMany` is one long-running
 * transaction that locks that range on the 1-vCPU Burstable DB until it either
 * finishes or trips `statement_timeout`, rolls back, and prunes NOTHING. The
 * `ts` predicate alone does NOT bound the statement — one SQL DELETE is one
 * transaction regardless of how many rows the WHERE matches. So `LogLine` is
 * pruned in an explicit id-chunked loop (`pruneOldLogLines`): each pass selects
 * a bounded page of the oldest eligible ids and deletes just those, so every
 * batch is its own short transaction that can't time out, and a backlog drains
 * incrementally across passes instead of all-or-nothing.
 */
import type { BuildStatus } from '@prisma/client';

import { prisma } from '../../db.js';
import { env } from '../../env.js';
import { logger } from '../../lib/logger.js';

const log = logger.child({ component: 'cleanup-builds' });

/** Build statuses safe to delete — a build in any of these has finished. */
const TERMINAL_STATUSES: BuildStatus[] = ['READY', 'FAILED', 'CANCELLED'];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Rows deleted per `LogLine` batch. Each batch is its own transaction, so this
 * is the upper bound on how many rows a single DELETE locks — small enough to
 * stay well under `statement_timeout` on the Burstable DB, large enough to keep
 * the round-trip count sane on a big backlog. Overridable per-call for tests.
 */
const DEFAULT_LOG_DELETE_BATCH_SIZE = 5_000;

/**
 * Hard cap on `LogLine` delete passes per run, so a pathological state (e.g. a
 * batch that selects rows it then can't delete) can never spin forever. At the
 * default batch size this bounds one run to ~500M rows — orders of magnitude
 * above any real backlog — after which the remainder is simply deferred to the
 * next scheduled run. A safety valve, never expected to trip in practice.
 */
const MAX_LOG_DELETE_ITERATIONS = 100_000;

export interface CleanupBuildsResult {
  logLinesDeleted: number;
  buildsDeleted: number;
}

export interface CleanupBuildsOptions {
  /** Override the `LogLine` delete batch size (defaults to {@link DEFAULT_LOG_DELETE_BATCH_SIZE}). */
  logDeleteBatchSize?: number;
}

/**
 * Delete every `LogLine` with `ts < cutoff` in bounded, individually-committed
 * batches. Returns the total rows deleted across all passes.
 *
 * Prisma's `deleteMany` has no `LIMIT`, so each batch first reads a page of the
 * oldest eligible ids, then deletes exactly those ids. The loop ends when a page
 * comes back short of a full batch (the tail — no more eligible rows), or empty.
 */
async function pruneOldLogLines(cutoff: Date, batchSize: number): Promise<number> {
  let totalDeleted = 0;

  for (let iteration = 0; iteration < MAX_LOG_DELETE_ITERATIONS; iteration++) {
    const page = await prisma.logLine.findMany({
      where: { ts: { lt: cutoff } },
      select: { id: true },
      orderBy: { ts: 'asc' },
      take: batchSize,
    });
    if (page.length === 0) break;

    const { count } = await prisma.logLine.deleteMany({
      where: { id: { in: page.map((row) => row.id) } },
    });
    totalDeleted += count;
    log.debug({ batchDeleted: count, totalDeleted }, 'log prune batch deleted');

    // A short page means we've reached the tail; the next findMany would be
    // empty, so skip the extra round-trip.
    if (page.length < batchSize) break;

    if (iteration === MAX_LOG_DELETE_ITERATIONS - 1) {
      log.warn(
        { totalDeleted, batchSize, maxIterations: MAX_LOG_DELETE_ITERATIONS },
        'log prune hit iteration cap; deferring remaining rows to next run',
      );
    }
  }

  return totalDeleted;
}

export async function cleanupBuilds(
  options: CleanupBuildsOptions = {},
): Promise<CleanupBuildsResult> {
  const batchSize = options.logDeleteBatchSize ?? DEFAULT_LOG_DELETE_BATCH_SIZE;
  const now = Date.now();
  const logsCutoff = new Date(now - env.RETENTION_DAYS_LOGS * DAY_MS);
  const buildsCutoff = new Date(now - env.RETENTION_DAYS_BUILDS * DAY_MS);

  // 1. Old log lines. Pruned in bounded, per-batch-committed chunks so a backlog
  //    can't become one long-locking transaction that trips statement_timeout.
  const logLinesDeleted = await pruneOldLogLines(logsCutoff, batchSize);

  // 2. Old terminal builds NOT referenced by any Deployment. Cascades to their
  //    remaining LogLines. `deployments: { none: {} }` is the data-loss guard —
  //    see the header note: never reap a build that backs a (possibly active)
  //    deployment, or its onDelete:Cascade would take the live Deployment with it.
  //    The OR guard adds the same protection for preview builds, which create NO
  //    Deployment row: never reap a build that backs an OPEN preview (closedAt
  //    null) — it's that preview's lastBuildId / log history, and Build.previewId
  //    is SetNull (no cascade protects it), so pruning it would dangle the
  //    "view logs" link. Builds of a torn-down preview (closedAt set) and
  //    non-preview builds still prune normally. (Unreachable today since the
  //    preview TTL ≪ RETENTION_DAYS_BUILDS, but a raised TTL would expose it.)
  const buildDelete = await prisma.build.deleteMany({
    where: {
      status: { in: TERMINAL_STATUSES },
      createdAt: { lt: buildsCutoff },
      deployments: { none: {} },
      OR: [{ previewId: null }, { preview: { closedAt: { not: null } } }],
    },
  });

  const result: CleanupBuildsResult = {
    logLinesDeleted,
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
