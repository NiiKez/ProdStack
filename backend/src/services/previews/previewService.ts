/**
 * Preview / PR environments — orchestration.
 *
 * A preview is an ephemeral per-PR Azure Container App built through the exact
 * same Kaniko pipeline as the main app (a normal `Build` row, just with
 * `previewId` set) but deployed to a distinct app name and never recorded as a
 * `Deployment` / never touching `Project.liveUrl`. This module owns the DB side:
 * the trusted-author gate, upsert-and-enqueue on PR open/sync, and teardown on
 * PR close / TTL expiry. The Azure create happens in the build worker
 * (runBuild.deployPreviewAndRecord); teardown's Azure delete happens here.
 *
 * Safety: previews never run for demo users (demo repos are synthetic, so a real
 * `pull_request` delivery can't match one — the webhook receiver already scopes
 * to non-demo projects). The trusted-author gate (no forks, author is
 * owner/member/collaborator) keeps the owner-gate security model intact: an
 * arbitrary external contributor can't get their Dockerfile executed on the
 * builder. See docs/PREVIEW_ENVIRONMENTS.md.
 */
import { Prisma, type PreviewEnvironment } from '@prisma/client';

import { prisma } from '../../db.js';
import { env } from '../../env.js';
import { logger } from '../../lib/logger.js';
import { deleteContainerApp } from '../azure/index.js';
import { previewContainerAppName } from '../slug.js';

/**
 * GitHub `author_association` values we treat as trusted to run a preview build.
 * OWNER/MEMBER/COLLABORATOR have write-ish access to the repo, so their PR head
 * is effectively first-party code. CONTRIBUTOR / FIRST_TIME_CONTRIBUTOR / NONE
 * are external and excluded — combined with the no-fork check, this means a
 * preview only ever builds code the repo's own trusted people pushed.
 */
const TRUSTED_ASSOCIATIONS: ReadonlySet<string> = new Set([
  'OWNER',
  'MEMBER',
  'COLLABORATOR',
]);

export interface PullRequestContext {
  prNumber: number;
  title: string;
  headRef: string;
  headSha: string;
  authorLogin: string;
  authorAssociation: string;
  /** head.repo.full_name !== base.repo.full_name (or head repo missing). */
  isFork: boolean;
}

/**
 * A PR is trusted to build a preview iff it is NOT from a fork AND its author is
 * an owner/member/collaborator of the repo. Pure + exported for unit testing.
 */
export function isTrustedPullRequest(pr: {
  authorAssociation: string;
  isFork: boolean;
}): boolean {
  return !pr.isFork && TRUSTED_ASSOCIATIONS.has(pr.authorAssociation);
}

/** Sliding TTL: now + PREVIEW_TTL_HOURS. Refreshed on every push to the PR. */
function ttlExpiry(): Date {
  return new Date(Date.now() + env.PREVIEW_TTL_HOURS * 60 * 60 * 1000);
}

export type UpsertPreviewResult =
  | { ok: true; previewId: string; buildId: string; created: boolean }
  | { ok: false; reason: 'limit_reached' | 'duplicate' };

/**
 * On a PR opened/reopened/synchronize: upsert the PreviewEnvironment for
 * `(projectId, prNumber)` and enqueue a (non-demo, claimable) preview Build of
 * the PR head. Records the delivery as a WebhookEvent in the same transaction
 * for idempotency (a redelivery is a clean no-op). Enforces the per-project
 * open-preview cap for NEW previews only — an existing preview always gets its
 * rebuild. Returns `{ok:false}` (still acknowledged) when the cap is hit or the
 * delivery is a duplicate.
 */
export async function upsertPreviewAndEnqueueBuild(opts: {
  projectId: string;
  deliveryId: string;
  pr: PullRequestContext;
}): Promise<UpsertPreviewResult> {
  const { projectId, deliveryId, pr } = opts;
  const containerAppName = previewContainerAppName(projectId, pr.prNumber);

  try {
    return await prisma.$transaction(async (tx) => {
      // Idempotency marker first — a concurrent retry of the same delivery trips
      // the P2002 below and we report `duplicate`.
      await tx.webhookEvent.create({ data: { id: deliveryId, projectId } });

      const existing = await tx.previewEnvironment.findFirst({
        where: { projectId, prNumber: pr.prNumber, closedAt: null },
      });

      if (!existing) {
        const openCount = await tx.previewEnvironment.count({
          where: { projectId, closedAt: null },
        });
        if (openCount >= env.PREVIEW_MAX_ACTIVE_PER_PROJECT) {
          // Cap hit: commit the WebhookEvent (so the delivery is acknowledged +
          // deduped) but create no preview/build.
          return { ok: false as const, reason: 'limit_reached' as const };
        }
      }

      const preview = existing
        ? await tx.previewEnvironment.update({
            where: { id: existing.id },
            data: {
              title: pr.title,
              headRef: pr.headRef,
              headSha: pr.headSha,
              authorLogin: pr.authorLogin,
              expiresAt: ttlExpiry(),
            },
          })
        : await tx.previewEnvironment.create({
            data: {
              projectId,
              prNumber: pr.prNumber,
              title: pr.title,
              headRef: pr.headRef,
              headSha: pr.headSha,
              authorLogin: pr.authorLogin,
              status: 'PENDING',
              containerAppName,
              expiresAt: ttlExpiry(),
            },
          });

      const build = await tx.build.create({
        data: {
          projectId,
          previewId: preview.id,
          commitSha: pr.headSha,
          commitMessage: pr.title,
          commitAuthor: pr.authorLogin,
          branch: pr.headRef,
          status: 'QUEUED',
        },
        select: { id: true },
      });

      // Link the newest build so the UI can jump to its logs immediately, even
      // before the deploy step sets it on success.
      await tx.previewEnvironment.update({
        where: { id: preview.id },
        data: { lastBuildId: build.id },
      });

      return { ok: true as const, previewId: preview.id, buildId: build.id, created: !existing };
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return { ok: false, reason: 'duplicate' };
    }
    throw err;
  }
}

/**
 * Tear down a preview: best-effort delete its Azure Container App, then mark the
 * row TORN_DOWN + closedAt (which frees its PR number for reuse via the partial
 * unique index). Idempotent — a second call on an already-torn-down preview is a
 * no-op. The Azure delete is best-effort: if the app was never created (build
 * still pending/failed) or Azure errors, we still flip the DB so the reaper /
 * UI converge and the row stops counting against the open-preview cap.
 */
export async function teardownPreview(previewId: string): Promise<void> {
  const preview = await prisma.previewEnvironment.findUnique({ where: { id: previewId } });
  if (preview === null) return;
  if (preview.closedAt !== null && preview.status === 'TORN_DOWN') return;

  try {
    await deleteContainerApp(preview.containerAppName);
  } catch (err) {
    logger.warn(
      { err, previewId, containerAppName: preview.containerAppName },
      'preview teardown: deleteContainerApp failed (continuing — flipping DB anyway)',
    );
  }

  await prisma.previewEnvironment.update({
    where: { id: previewId },
    data: { status: 'TORN_DOWN', closedAt: new Date(), liveUrl: null },
  });
}

/** Tear down the open preview for a PR (PR-closed webhook). Returns whether one was found. */
export async function teardownPreviewByPr(
  projectId: string,
  prNumber: number,
): Promise<boolean> {
  const preview = await prisma.previewEnvironment.findFirst({
    where: { projectId, prNumber, closedAt: null },
  });
  if (preview === null) return false;
  await teardownPreview(preview.id);
  return true;
}

/**
 * Mark a preview FAILED, but only if it never successfully deployed (still
 * PENDING). A failed REBUILD of an already-ACTIVE preview leaves the prior app
 * serving, so we keep it ACTIVE. Best-effort — called from the build worker's
 * failure path.
 */
export async function markPreviewFailedIfPending(previewId: string): Promise<void> {
  await prisma.previewEnvironment.updateMany({
    where: { id: previewId, status: 'PENDING' },
    data: { status: 'FAILED' },
  });
}

/** All previews for a project (open + torn-down), newest first, capped. */
export async function listPreviews(projectId: string): Promise<PreviewEnvironment[]> {
  return prisma.previewEnvironment.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
}
