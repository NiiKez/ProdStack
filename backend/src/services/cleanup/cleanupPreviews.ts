/**
 * Preview-environment reaper.
 *
 * The PR-closed webhook is the primary teardown trigger, but it can be missed
 * (delivery dropped, previews enabled after a PR was already open, ProdStack
 * down when the PR closed). This hourly job is the backstop: it tears down any
 * preview whose sliding TTL (`expiresAt`, refreshed on every push) has lapsed
 * while still open, so a leaked preview Container App can't idle forever. The
 * TTL is the hard cost ceiling for orphaned previews. See
 * docs/PREVIEW_ENVIRONMENTS.md.
 */
import { logger } from '../../lib/logger.js';
import { teardownPreview } from '../previews/previewService.js';
import { prisma } from '../../db.js';

export interface PreviewCleanupResult {
  scanned: number;
  tornDown: number;
}

/**
 * Tear down every open preview past its TTL. `now` is injectable for tests.
 * Each teardown is best-effort (a failure on one doesn't abort the sweep); the
 * Azure delete inside `teardownPreview` is itself best-effort and the DB flip
 * still happens so the row stops counting against the cap on a retry.
 */
/** Max previews torn down in a single sweep; the rest are caught next tick. */
const MAX_PER_SWEEP = 200;

export async function cleanupExpiredPreviews(now: Date = new Date()): Promise<PreviewCleanupResult> {
  const expired = await prisma.previewEnvironment.findMany({
    where: {
      closedAt: null,
      status: { not: 'TORN_DOWN' },
      expiresAt: { lt: now },
    },
    select: { id: true, prNumber: true, projectId: true },
    // Bound a single tick: each teardown awaits a serial Azure delete, so cap the
    // batch so a backlog (webhook outage, previews enabled across many projects)
    // can't run an unbounded serial loop. The hourly cron picks up the remainder.
    orderBy: { expiresAt: 'asc' },
    take: MAX_PER_SWEEP,
  });
  if (expired.length === MAX_PER_SWEEP) {
    logger.warn(
      { cap: MAX_PER_SWEEP },
      'preview reaper: hit the per-sweep cap — remaining expired previews deferred to the next tick',
    );
  }

  let tornDown = 0;
  for (const p of expired) {
    try {
      await teardownPreview(p.id);
      tornDown += 1;
    } catch (err) {
      logger.warn(
        { err, previewId: p.id, projectId: p.projectId, prNumber: p.prNumber },
        'preview reaper: teardown failed',
      );
    }
  }

  if (expired.length > 0) {
    logger.info({ scanned: expired.length, tornDown }, 'preview reaper: swept expired previews');
  }
  return { scanned: expired.length, tornDown };
}
