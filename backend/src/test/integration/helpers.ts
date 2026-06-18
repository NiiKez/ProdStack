// Shared fixtures/helpers for the real-Postgres integration tier.
//
// These build minimal valid rows (the schema has several required `Bytes`
// columns for ciphertext that we just fill with dummy bytes — we're testing DB
// constraints/queue behavior, not crypto) and a truncate helper so each test
// isolates its own data even though the suite runs in a single worker.

import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

const dummyBytes = () => Buffer.from('x');

// Monotonic source for the external integer ids (githubUserId / githubRepoId).
// `User.githubUserId` is @unique, so the previous `Math.random()` carried a
// small-but-real P2002 collision flake when a single test created several
// users. The tier runs single-fork with module state preserved across files,
// so this counter is globally unique for the whole run.
let nextExternalId = 1;

/** Create a real User row. `isDemo` toggles the demo flag used by queue filters. */
export async function createUser(
  prisma: PrismaClient,
  opts: { isDemo?: boolean; githubUserId?: number } = {},
): Promise<string> {
  const user = await prisma.user.create({
    data: {
      githubUserId: opts.githubUserId ?? nextExternalId++,
      githubLogin: `it-${randomUUID().slice(0, 8)}`,
      githubTokenCiphertext: dummyBytes(),
      githubTokenIv: dummyBytes(),
      githubTokenAuthTag: dummyBytes(),
      isDemo: opts.isDemo ?? false,
    },
  });
  return user.id;
}

/** Create a real Project row owned by `userId`. */
export async function createProject(
  prisma: PrismaClient,
  userId: string,
  opts: { slug?: string; deletedAt?: Date | null } = {},
): Promise<string> {
  const slug = opts.slug ?? `proj-${randomUUID().slice(0, 8)}`;
  const project = await prisma.project.create({
    data: {
      userId,
      name: slug,
      slug,
      githubRepoFullName: `it/${slug}`,
      githubRepoId: nextExternalId++,
      webhookSecretCiphertext: dummyBytes(),
      webhookSecretIv: dummyBytes(),
      webhookSecretAuthTag: dummyBytes(),
      containerAppName: `app-${slug}`,
      deletedAt: opts.deletedAt ?? null,
    },
  });
  return project.id;
}

/**
 * Truncate every table (RESTART IDENTITY CASCADE) so each test starts clean.
 * Order doesn't matter with CASCADE. Cheap on an empty-ish schema.
 */
export async function truncateAll(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE ' +
      '"LogLine","Deployment","Build","EnvVar","WebhookEvent","PreviewEnvironment","Project","User" ' +
      'RESTART IDENTITY CASCADE',
  );
}
