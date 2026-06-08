/**
 * Demo-session reaper (demo mode §6.7).
 *
 * Each public "Launch demo" session is one ephemeral `User` row
 * (`isDemo=true`, `demoExpiresAt = now + DEMO_TTL_MINUTES`). This job purges
 * every demo user whose TTL has lapsed, on an hourly cadence (the daily
 * build/log cadence is far too slow for a 2h-default demo TTL — see the
 * scheduler).
 *
 * Deleting the `User` row is enough: the schema's `onDelete: Cascade` FKs
 * (`User → Project → Build / Deployment / EnvVar / LogLine / WebhookEvent`)
 * remove ALL of that demo session's data automatically. No keep-set or
 * data-loss guard is needed — unlike `cleanupBuilds`, a demo user protects
 * nothing real: its deployments carry fake image tags that never exist in ACR,
 * and its rows are throwaway sandbox state by design. So an unconditional
 * `deleteMany` on the expiry predicate is correct and safe.
 *
 * The `User.@@index([isDemo, demoExpiresAt])` backs this query directly.
 */
import { prisma } from '../../db.js';
import { logger } from '../../lib/logger.js';

const log = logger.child({ component: 'cleanup-demo' });

export interface CleanupDemoResult {
  demoUsersDeleted: number;
}

export async function cleanupDemo(): Promise<CleanupDemoResult> {
  const now = new Date();

  // Cascade (onDelete: Cascade on the User→Project→… FK chain) removes every
  // project/build/deployment/logline/envvar/webhook-event of each reaped demo
  // user — no separate child deletes needed.
  const res = await prisma.user.deleteMany({
    where: { isDemo: true, demoExpiresAt: { lt: now } },
  });

  const result: CleanupDemoResult = { demoUsersDeleted: res.count };

  log.info({ ...result }, 'demo cleanup complete');
  return result;
}
