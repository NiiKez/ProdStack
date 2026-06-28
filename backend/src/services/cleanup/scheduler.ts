/**
 * Cost-safeguard cleanup scheduler (M6 §2.14).
 *
 * Runs the two daily cleanup jobs (ACR image GC + Postgres build/log pruning)
 * via node-cron, IN-PROCESS in the API. Owner decision (M6): cleanup is an
 * in-process node-cron job in the API rather than a separate worker or an ACR
 * retention policy (Basic SKU has none). Gated by
 * `ENABLE_CLEANUP_JOBS` (NOT `ENABLE_WORKER`, which in prod runs only on the
 * dedicated builder Container App; see env.ts).
 *
 * Both jobs run daily at ~03:17 (a low-traffic hour, offset off the top of the
 * hour to avoid colliding with anything else cron-y). Deliberately NOT run on
 * boot: a revision roll restarts the API, and running GC on every restart would
 * be a thundering herd against ACR / Postgres. cron-only → at most once a day.
 *
 * Each job is wrapped in try/catch so a failure (e.g. ACR throttling, a DB
 * hiccup) is logged and never crashes the API process or stops the schedule.
 */
import cron, { type ScheduledTask } from 'node-cron';

import { env } from '../../env.js';
import { logger } from '../../lib/logger.js';
import { cleanupBuilds } from './cleanupBuilds.js';
import { cleanupDemo } from './cleanupDemo.js';
import { cleanupExpiredPreviews } from './cleanupPreviews.js';
import { cleanupImages } from './cleanupImages.js';

const log = logger.child({ component: 'cleanup-scheduler' });

/** ~03:17 daily. Offset off :00 to dodge other top-of-hour jobs. */
const CRON_SCHEDULE = '17 3 * * *';

/**
 * Demo-session reaper cadence: hourly at :42. The demo TTL is short
 * (DEMO_TTL_MINUTES, default 120) so the daily CRON_SCHEDULE would let an
 * expired sandbox linger up to ~24h; an hourly sweep keeps the lag under an
 * hour. Offset off :00 (same convention as CRON_SCHEDULE) to dodge other
 * top-of-hour jobs.
 */
const DEMO_CRON_SCHEDULE = '42 * * * *';

/**
 * Preview-environment reaper cadence: hourly at :27. Previews carry a sliding
 * TTL (PREVIEW_TTL_HOURS, default 72) refreshed on every push; this backstops a
 * missed PR-closed webhook so a leaked preview Container App can't idle forever.
 * Offset off :00 and off the demo reaper's :42 to spread the load.
 */
const PREVIEW_CRON_SCHEDULE = '27 * * * *';

export interface CleanupSchedulerHandle {
  stop: () => void;
}

/**
 * Wrap a cleanup job so a still-running invocation can't overlap the next cron
 * tick — node-cron does NOT serialize ticks, so a slow run (ACR throttling, a
 * big prune) could otherwise double-walk ACR / double-prune Postgres if the
 * schedule fires again before it finishes. If a job is already in progress we
 * log and skip. (This guards a single process; cross-replica overlap would need
 * a DB lock, but the API is pinned to one replica.) Exported for unit testing.
 */
export function withOverlapGuard(
  name: string,
  job: () => Promise<void>,
): () => Promise<void> {
  let running = false;
  return async () => {
    if (running) {
      log.warn({ job: name }, 'previous cleanup run still in progress — skipping this tick');
      return;
    }
    running = true;
    try {
      await job();
    } finally {
      running = false;
    }
  };
}

async function runImageCleanup(): Promise<void> {
  log.info('image cleanup job starting');
  try {
    const res = await cleanupImages();
    log.info({ ...res }, 'image cleanup job finished');
  } catch (err) {
    log.error({ err }, 'image cleanup job failed');
  }
}

async function runBuildCleanup(): Promise<void> {
  log.info('build/log cleanup job starting');
  try {
    const res = await cleanupBuilds();
    log.info({ ...res }, 'build/log cleanup job finished');
  } catch (err) {
    log.error({ err }, 'build/log cleanup job failed');
  }
}

async function runDemoCleanup(): Promise<void> {
  log.info('demo cleanup job starting');
  try {
    const res = await cleanupDemo();
    log.info({ ...res }, 'demo cleanup job finished');
  } catch (err) {
    log.error({ err }, 'demo cleanup job failed');
  }
}

async function runPreviewCleanup(): Promise<void> {
  log.info('preview cleanup job starting');
  try {
    const res = await cleanupExpiredPreviews();
    log.info({ ...res }, 'preview cleanup job finished');
  } catch (err) {
    log.error({ err }, 'preview cleanup job failed');
  }
}

export function startCleanupScheduler(): CleanupSchedulerHandle {
  log.info(
    {
      schedule: CRON_SCHEDULE,
      demoSchedule: DEMO_CRON_SCHEDULE,
      previewSchedule: PREVIEW_CRON_SCHEDULE,
      retentionDaysImages: env.RETENTION_DAYS_IMAGES,
      retentionDaysLogs: env.RETENTION_DAYS_LOGS,
      retentionDaysBuilds: env.RETENTION_DAYS_BUILDS,
      demoTtlMinutes: env.DEMO_TTL_MINUTES,
    },
    'cleanup scheduler starting',
  );

  // Wrap each runner once so its `running` flag persists across ticks.
  const imageJob = withOverlapGuard('image', runImageCleanup);
  const buildJob = withOverlapGuard('build', runBuildCleanup);
  const demoJob = withOverlapGuard('demo', runDemoCleanup);
  const previewJob = withOverlapGuard('preview', runPreviewCleanup);

  const tasks: ScheduledTask[] = [
    cron.schedule(CRON_SCHEDULE, () => {
      void imageJob();
    }),
    cron.schedule(CRON_SCHEDULE, () => {
      void buildJob();
    }),
    cron.schedule(DEMO_CRON_SCHEDULE, () => {
      void demoJob();
    }),
    cron.schedule(PREVIEW_CRON_SCHEDULE, () => {
      void previewJob();
    }),
  ];

  return {
    stop: () => {
      for (const task of tasks) task.stop();
      log.info('cleanup scheduler stopped');
    },
  };
}
