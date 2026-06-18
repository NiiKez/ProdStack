// Real-Postgres integration tests for the three hand-maintained PARTIAL UNIQUE
// indexes. Prisma can't express WHERE-filtered uniques, so they live only in
// raw migration SQL — the fast mocked suite can never prove they were created
// or that Postgres actually enforces them. Here we assert a genuine P2002 from
// the live engine, and that the partial WHERE clause lets the constrained pair
// be reused once the row is soft-deleted / closed.

import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it } from 'vitest';

import { prisma } from '../../db.js';
import { createProject, createUser, truncateAll } from './helpers.js';

const dummy = () => Buffer.from('x');

/**
 * Assert a thrown error is a REAL Prisma P2002 unique-constraint violation from
 * Postgres (not something a mock could synthesize). `targetColumns`, if given,
 * is matched against `meta.target` — on the Postgres driver Prisma surfaces the
 * violated unique's COLUMN LIST there (e.g. `["userId","slug"]`), not the index
 * name; that list pins which constraint fired.
 */
async function expectP2002(
  fn: () => Promise<unknown>,
  targetColumns?: string[],
): Promise<void> {
  try {
    await fn();
    throw new Error('expected a P2002 unique-constraint violation, but the insert succeeded');
  } catch (err) {
    expect(err).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    const e = err as Prisma.PrismaClientKnownRequestError;
    expect(e.code).toBe('P2002');
    if (targetColumns) {
      expect(e.meta?.target).toEqual(targetColumns);
    }
  }
}

describe('partial unique indexes (real Postgres)', () => {
  beforeEach(async () => {
    await truncateAll(prisma);
  });

  describe('project_user_slug_live ON Project(userId,slug) WHERE deletedAt IS NULL', () => {
    it('rejects a duplicate LIVE slug for the same user (P2002) but allows reuse after soft-delete', async () => {
      const userId = await createUser(prisma);
      await createProject(prisma, userId, { slug: 'dup' });

      // Second LIVE project with the same (userId, slug) -> partial index fires.
      await expectP2002(() => createProject(prisma, userId, { slug: 'dup' }), ['userId', 'slug']);

      // Soft-delete the first, then recreate with the same slug -> allowed,
      // because the tombstone row is excluded by WHERE deletedAt IS NULL.
      const first = await prisma.project.findFirstOrThrow({ where: { userId, slug: 'dup' } });
      await prisma.project.update({ where: { id: first.id }, data: { deletedAt: new Date() } });

      const recreated = await createProject(prisma, userId, { slug: 'dup' });
      expect(recreated).toBeTruthy();

      // Two rows share the slug now, but only one is live.
      const live = await prisma.project.count({ where: { userId, slug: 'dup', deletedAt: null } });
      expect(live).toBe(1);
    });

    it('allows the same slug across different users', async () => {
      const u1 = await createUser(prisma);
      const u2 = await createUser(prisma);
      await createProject(prisma, u1, { slug: 'shared' });
      const ok = await createProject(prisma, u2, { slug: 'shared' });
      expect(ok).toBeTruthy();
    });
  });

  describe('one_active_per_project ON Deployment(projectId) WHERE active=true', () => {
    async function seedBuild(projectId: string): Promise<string> {
      const b = await prisma.build.create({
        data: {
          projectId,
          commitSha: 'c',
          commitMessage: 'm',
          commitAuthor: 'a',
          branch: 'main',
          status: 'READY',
        },
      });
      return b.id;
    }

    it('rejects a second active=true deployment on the same project (P2002), allows many inactive', async () => {
      const userId = await createUser(prisma);
      const projectId = await createProject(prisma, userId);
      const b1 = await seedBuild(projectId);
      const b2 = await seedBuild(projectId);
      const b3 = await seedBuild(projectId);

      await prisma.deployment.create({
        data: { projectId, buildId: b1, revisionName: 'r1', active: true },
      });
      // Inactive ones are fine in any number.
      await prisma.deployment.create({
        data: { projectId, buildId: b2, revisionName: 'r2', active: false },
      });

      await expectP2002(
        () =>
          prisma.deployment.create({
            data: { projectId, buildId: b3, revisionName: 'r3', active: true },
          }),
        ['projectId'],
      );

      const active = await prisma.deployment.count({ where: { projectId, active: true } });
      expect(active).toBe(1);
    });
  });

  describe('preview_project_pr_open ON PreviewEnvironment(projectId,prNumber) WHERE closedAt IS NULL', () => {
    async function seedPreview(
      projectId: string,
      prNumber: number,
      closedAt: Date | null,
    ): Promise<string> {
      const p = await prisma.previewEnvironment.create({
        data: {
          projectId,
          prNumber,
          title: 't',
          headRef: 'feat',
          headSha: 'sha',
          authorLogin: 'me',
          containerAppName: `prev-${prNumber}-${Math.random().toString(36).slice(2, 7)}`,
          expiresAt: new Date(Date.now() + 3600_000),
          closedAt,
        },
      });
      return p.id;
    }

    it('rejects a second OPEN preview for the same (project,PR) (P2002) but allows a new one after the first is closed', async () => {
      const userId = await createUser(prisma);
      const projectId = await createProject(prisma, userId);

      const open1 = await seedPreview(projectId, 42, null);

      await expectP2002(() => seedPreview(projectId, 42, null), ['projectId', 'prNumber']);

      // Close the first -> closedAt set -> excluded by the partial WHERE.
      await prisma.previewEnvironment.update({
        where: { id: open1 },
        data: { closedAt: new Date(), status: 'TORN_DOWN' },
      });

      const reopened = await seedPreview(projectId, 42, null);
      expect(reopened).toBeTruthy();

      const open = await prisma.previewEnvironment.count({
        where: { projectId, prNumber: 42, closedAt: null },
      });
      expect(open).toBe(1);
    });

    it('allows the same PR number across different projects', async () => {
      const userId = await createUser(prisma);
      const p1 = await createProject(prisma, userId);
      const p2 = await createProject(prisma, userId);
      await seedPreview(p1, 7, null);
      const ok = await seedPreview(p2, 7, null);
      expect(ok).toBeTruthy();
    });
  });

  // Sanity: prove the EnvVar plain @@unique([projectId,key]) is real too
  // (a regular unique, not partial) — guards the migration chain created it.
  it('enforces EnvVar @@unique(projectId,key) at the engine', async () => {
    const userId = await createUser(prisma);
    const projectId = await createProject(prisma, userId);
    await prisma.envVar.create({
      data: {
        projectId,
        key: 'API_KEY',
        valueCiphertext: dummy(),
        valueIv: dummy(),
        valueAuthTag: dummy(),
      },
    });
    await expectP2002(() =>
      prisma.envVar.create({
        data: {
          projectId,
          key: 'API_KEY',
          valueCiphertext: dummy(),
          valueIv: dummy(),
          valueAuthTag: dummy(),
        },
      }),
    );
  });
});
