// Real-Postgres integration tests for the build queue (queue.ts).
//
// Exercises behavior that the fast mocked suite can only stub: the actual
// `FOR UPDATE SKIP LOCKED` atomic lease against a live engine (no double-claim
// under real concurrency), the `isDemo`/`claimedAt`/`attempts` row predicates,
// and the recoverOwnClaims status transitions over real rows. We import the REAL
// db.ts singleton (pointed at the container by integration/setup.ts) — no mock.

import { beforeEach, describe, expect, it } from 'vitest';

import { prisma } from '../../db.js';
import { createProject, createUser, truncateAll } from '../../test/integration/helpers.js';
import { claimNextBuild, failExhaustedBuilds, recoverOwnClaims } from './queue.js';

const MAX_ATTEMPTS = 3;

async function seedBuild(
  projectId: string,
  overrides: Partial<{
    status:
      | 'QUEUED'
      | 'CLONING'
      | 'BUILDING'
      | 'PUSHING'
      | 'DEPLOYING'
      | 'READY'
      | 'FAILED'
      | 'CANCELLED';
    isDemo: boolean;
    claimedAt: Date | null;
    claimedBy: string | null;
    attempts: number;
    cancelRequested: boolean;
    createdAt: Date;
  }> = {},
): Promise<string> {
  const b = await prisma.build.create({
    data: {
      projectId,
      commitSha: 'deadbeef',
      commitMessage: 'it',
      commitAuthor: 'it',
      branch: 'main',
      status: overrides.status ?? 'QUEUED',
      isDemo: overrides.isDemo ?? false,
      claimedAt: overrides.claimedAt ?? null,
      claimedBy: overrides.claimedBy ?? null,
      attempts: overrides.attempts ?? 0,
      cancelRequested: overrides.cancelRequested ?? false,
      ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
    },
  });
  return b.id;
}

describe('queue (real Postgres)', () => {
  beforeEach(async () => {
    await truncateAll(prisma);
  });

  describe('claimNextBuild — FOR UPDATE SKIP LOCKED', () => {
    it('hands each QUEUED build to exactly one concurrent claimer (no double-claim)', async () => {
      const userId = await createUser(prisma);
      const projectId = await createProject(prisma, userId);

      const N = 12;
      const ids = new Set<string>();
      for (let i = 0; i < N; i++) {
        // Distinct createdAt so ORDER BY createdAt ASC is deterministic; not
        // load-bearing for the no-double-claim assertion but realistic.
        ids.add(await seedBuild(projectId, { createdAt: new Date(Date.now() + i) }));
      }

      // Fire many more concurrent claims than there are builds. Each worker id
      // is unique. Real SKIP LOCKED must ensure every build goes to exactly one
      // claimer and no build is handed out twice.
      const claimers = Array.from({ length: N + 8 }, (_, i) =>
        claimNextBuild(`worker-${i}`, MAX_ATTEMPTS),
      );
      const results = await Promise.all(claimers);

      const claimedIds = results.filter((r): r is { id: string; attempts: number } => r !== null);
      const claimedSet = new Set(claimedIds.map((r) => r.id));

      // Exactly N distinct builds claimed; the extra claimers got null.
      expect(claimedIds.length).toBe(N);
      expect(claimedSet.size).toBe(N);
      expect(claimedSet).toEqual(ids);

      // Every build is now claimed exactly once in the DB.
      const rows = await prisma.build.findMany({ where: { projectId } });
      expect(rows.every((r) => r.claimedAt !== null && r.claimedBy !== null)).toBe(true);
      expect(rows.every((r) => r.attempts === 1)).toBe(true);
    });

    it('never claims demo builds (isDemo=true) even when QUEUED and unclaimed', async () => {
      const realUser = await createUser(prisma, { isDemo: false });
      const realProject = await createProject(prisma, realUser);
      const demoUser = await createUser(prisma, { isDemo: true });
      const demoProject = await createProject(prisma, demoUser);

      const demoBuild = await seedBuild(demoProject, { isDemo: true });
      const realBuild = await seedBuild(realProject, { isDemo: false });

      // Drain the queue.
      const claimed: string[] = [];
      let next = await claimNextBuild('w1', MAX_ATTEMPTS);
      while (next) {
        claimed.push(next.id);
        next = await claimNextBuild('w1', MAX_ATTEMPTS);
      }

      expect(claimed).toContain(realBuild);
      expect(claimed).not.toContain(demoBuild);

      // Demo build untouched.
      const demo = await prisma.build.findUniqueOrThrow({ where: { id: demoBuild } });
      expect(demo.claimedAt).toBeNull();
      expect(demo.attempts).toBe(0);
    });

    it('honors the attempts<maxAttempts poison-pill cap', async () => {
      const userId = await createUser(prisma);
      const projectId = await createProject(prisma, userId);
      // Already at the cap -> ineligible.
      const exhausted = await seedBuild(projectId, { attempts: MAX_ATTEMPTS });

      const claim = await claimNextBuild('w1', MAX_ATTEMPTS);
      expect(claim).toBeNull();

      const row = await prisma.build.findUniqueOrThrow({ where: { id: exhausted } });
      expect(row.attempts).toBe(MAX_ATTEMPTS);
      expect(row.claimedAt).toBeNull();

      // failExhaustedBuilds reaps it to FAILED.
      const reaped = await failExhaustedBuilds(MAX_ATTEMPTS);
      expect(reaped).toBe(1);
      const after = await prisma.build.findUniqueOrThrow({ where: { id: exhausted } });
      expect(after.status).toBe('FAILED');
    });
  });

  describe('recoverOwnClaims — real transitions', () => {
    it('releases stale QUEUED claims (claimedAt cleared) and respects worker-id match', async () => {
      const userId = await createUser(prisma);
      const projectId = await createProject(prisma, userId);

      const stale = new Date(Date.now() - 60 * 60 * 1000); // 1h ago
      // Mine by worker id, still QUEUED -> released.
      const mineQueued = await seedBuild(projectId, {
        status: 'QUEUED',
        claimedAt: new Date(),
        claimedBy: 'worker-me',
      });
      // Another live worker's fresh claim -> NOT mine, not stale -> untouched.
      const otherFresh = await seedBuild(projectId, {
        status: 'QUEUED',
        claimedAt: new Date(),
        claimedBy: 'worker-other',
      });
      // Orphaned by age (different worker id but claimed long ago) -> released.
      const staleByAge = await seedBuild(projectId, {
        status: 'QUEUED',
        claimedAt: stale,
        claimedBy: 'worker-ghost',
      });

      const count = await recoverOwnClaims('worker-me', 5 * 60 * 1000);
      expect(count).toBe(2); // mineQueued + staleByAge

      expect((await prisma.build.findUniqueOrThrow({ where: { id: mineQueued } })).claimedAt).toBeNull();
      expect((await prisma.build.findUniqueOrThrow({ where: { id: staleByAge } })).claimedAt).toBeNull();
      const other = await prisma.build.findUniqueOrThrow({ where: { id: otherFresh } });
      expect(other.claimedAt).not.toBeNull();
      expect(other.claimedBy).toBe('worker-other');
    });

    it('in-flight + cancelRequested -> CANCELLED; in-flight without -> FAILED', async () => {
      const userId = await createUser(prisma);
      const projectId = await createProject(prisma, userId);

      const cancelled = await seedBuild(projectId, {
        status: 'BUILDING',
        claimedBy: 'worker-me',
        claimedAt: new Date(),
        cancelRequested: true,
      });
      const failed = await seedBuild(projectId, {
        status: 'PUSHING',
        claimedBy: 'worker-me',
        claimedAt: new Date(),
        cancelRequested: false,
      });

      const count = await recoverOwnClaims('worker-me', 5 * 60 * 1000);
      expect(count).toBe(2);

      const c = await prisma.build.findUniqueOrThrow({ where: { id: cancelled } });
      expect(c.status).toBe('CANCELLED');
      expect(c.errorMessage).toBe('cancelled by user');
      expect(c.finishedAt).not.toBeNull();

      const f = await prisma.build.findUniqueOrThrow({ where: { id: failed } });
      expect(f.status).toBe('FAILED');
      expect(f.errorMessage).toBe('worker restarted mid-build');
      expect(f.finishedAt).not.toBeNull();
    });

    it('never touches demo builds in recovery', async () => {
      const demoUser = await createUser(prisma, { isDemo: true });
      const demoProject = await createProject(prisma, demoUser);
      const stale = new Date(Date.now() - 60 * 60 * 1000);
      const demoInFlight = await seedBuild(demoProject, {
        status: 'BUILDING',
        isDemo: true,
        claimedBy: 'worker-ghost',
        claimedAt: stale,
        cancelRequested: false,
      });

      const count = await recoverOwnClaims('worker-me', 5 * 60 * 1000);
      expect(count).toBe(0);
      const row = await prisma.build.findUniqueOrThrow({ where: { id: demoInFlight } });
      expect(row.status).toBe('BUILDING');
    });
  });
});
