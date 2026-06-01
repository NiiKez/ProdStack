/**
 * Deployment rollback (PLAN.md M5 §2.9).
 *
 * Rollback is a **re-tag/redeploy** of a previous successful build's image, not
 * an Azure revision-activation toggle. The decision (PLAN.md M5 "Decisions"):
 * re-deploying the stored image is simpler than juggling Container App revision
 * weights, and it produces a clean new `Deployment` row referencing the
 * original `Build` — so the deployments table and activity feed read as a real
 * timeline ("rolled back to <sha>") instead of mutating history in place.
 *
 * The same `updateContainerApp` chokepoint the build runner uses does the
 * actual roll, and the project's current env vars are re-applied as secrets in
 * the same call (a rollback should run with today's config, not the config
 * captured at original-build time).
 */
import { BuildStatus, Prisma } from '@prisma/client';

import { prisma } from '../db.js';
import { HttpError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { updateContainerApp } from './azure/index.js';
import { loadDecryptedEnvVars } from './projectEnv.js';

const deploymentWithBuild = {
  include: { build: true, project: true },
} satisfies Prisma.DeploymentDefaultArgs;

/**
 * Non-terminal build states: a build is still running and may roll a revision.
 * Shared by the rollback / config-redeploy guards here and the manual-rebuild
 * guard in `routes/projects.ts` so "is a build in flight?" means the same thing
 * everywhere — adding a new transient `BuildStatus` only needs editing here.
 */
export const IN_FLIGHT_BUILD_STATUSES: BuildStatus[] = [
  BuildStatus.QUEUED,
  BuildStatus.CLONING,
  BuildStatus.BUILDING,
  BuildStatus.PUSHING,
  BuildStatus.DEPLOYING,
];

export type RolledBackDeployment = Prisma.DeploymentGetPayload<{ include: { build: true } }>;

/**
 * Roll `projectId` back to the image produced by the build behind
 * `deploymentId`. Ownership is enforced here (scoped to a live project owned by
 * `userId`) so the route handler doesn't have to re-check. Returns the freshly
 * created active `Deployment` with its `build` included for serialization.
 */
export async function rollbackToDeployment(opts: {
  projectId: string;
  deploymentId: string;
  userId: string;
}): Promise<RolledBackDeployment> {
  const target = await prisma.deployment.findFirst({
    where: {
      id: opts.deploymentId,
      projectId: opts.projectId,
      project: { userId: opts.userId, deletedAt: null },
    },
    ...deploymentWithBuild,
  });

  if (target === null) {
    throw new HttpError(404, 'DEPLOYMENT_NOT_FOUND');
  }
  if (target.active) {
    throw new HttpError(409, 'ALREADY_ACTIVE', 'That deployment is already live.');
  }

  // Only a READY build has an image that was actually built and pushed to ACR.
  // `imageTag` is set at the BUILDING phase (before the kaniko push), so a
  // FAILED/CANCELLED build can carry a non-null tag that points at an image
  // that never made it to the registry — redeploying it would leave the app
  // pulling a nonexistent image. Require terminal success before rolling.
  if (target.build.status !== BuildStatus.READY) {
    throw new HttpError(
      409,
      'BUILD_NOT_DEPLOYABLE',
      'That deployment’s build did not finish successfully, so it cannot be redeployed.',
    );
  }

  const image = target.build.imageTag;
  if (image === null || image === '') {
    throw new HttpError(
      409,
      'NO_IMAGE_FOR_BUILD',
      'That build never produced an image, so it cannot be redeployed.',
    );
  }

  // Refuse to roll back while a build for this project is in flight: it would
  // race the build runner's own deploy (both call `updateContainerApp` and
  // flip the active deployment), making the last writer win nondeterministically.
  const inFlight = await prisma.build.findFirst({
    where: { projectId: opts.projectId, status: { in: IN_FLIGHT_BUILD_STATUSES } },
    select: { id: true },
  });
  if (inFlight !== null) {
    throw new HttpError(
      409,
      'BUILD_IN_PROGRESS',
      'A build is currently running for this project. Wait for it to finish before rolling back.',
    );
  }

  const envVars = await loadDecryptedEnvVars(opts.projectId);

  logger.info(
    { projectId: opts.projectId, deploymentId: opts.deploymentId, image },
    'rolling back deployment',
  );

  const deploy = await updateContainerApp({
    name: target.project.containerAppName,
    image,
    envVars,
  });

  try {
    return await prisma.$transaction(async (tx) => {
      await tx.deployment.updateMany({
        where: { projectId: opts.projectId, active: true },
        data: { active: false },
      });
      const row = await tx.deployment.create({
        data: {
          projectId: opts.projectId,
          buildId: target.buildId,
          revisionName: deploy.revisionName ?? target.revisionName,
          active: true,
          rolledBack: true,
        },
        include: { build: true },
      });
      await tx.project.update({
        where: { id: opts.projectId },
        data: { liveUrl: deploy.liveUrl },
      });
      return row;
    });
  } catch (err) {
    // The `one_active_per_project` partial-unique index is the backstop against
    // two concurrent rollbacks/deploys both inserting an active row. Surface
    // that race as a clean 409 instead of a generic 500. (Azure was already
    // rolled to `image` at this point; a retry reconciles the DB.)
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new HttpError(
        409,
        'ROLLBACK_CONFLICT',
        'The active deployment changed while rolling back. Please retry.',
      );
    }
    throw err;
  }
}

export type RedeployReason = 'NO_ACTIVE_DEPLOYMENT' | 'BUILD_IN_PROGRESS' | 'NO_IMAGE';

export interface RedeployResult {
  redeployed: boolean;
  reason?: RedeployReason;
  deployment?: RolledBackDeployment;
}

/**
 * Config-only redeploy: re-roll the project's **current active image** with its
 * freshly-saved env vars applied as Container App secrets. Called after an
 * env-var save (PATCH /projects/:id) so a config change goes live without a git
 * push — same image, refreshed secrets.
 *
 * This is a best-effort, non-fatal operation from the caller's perspective: the
 * env vars are already persisted, so every "can't redeploy right now" condition
 * returns `{ redeployed: false, reason }` instead of throwing. The new env vars
 * will still apply on the next build or rollback. The only thrown error is the
 * `one_active_per_project` race (mapped to 409 ROLLBACK_CONFLICT, mirroring
 * rollback), which the route downgrades to a non-fatal summary.
 *
 * Writes a normal (`rolledBack: false`) Deployment row so the new Azure revision
 * name is recorded and the activity feed shows a `deployment.created` event.
 */
export async function redeployWithCurrentEnv(opts: {
  projectId: string;
  userId: string;
}): Promise<RedeployResult> {
  const active = await prisma.deployment.findFirst({
    where: {
      projectId: opts.projectId,
      active: true,
      project: { userId: opts.userId, deletedAt: null },
    },
    ...deploymentWithBuild,
  });

  // Nothing live to redeploy — the env vars will apply on the first build.
  if (active === null) {
    return { redeployed: false, reason: 'NO_ACTIVE_DEPLOYMENT' };
  }

  // The active deployment must point at a build whose image actually shipped to
  // ACR. A non-READY build or an empty `imageTag` would have us re-roll a
  // nonexistent image; skip instead.
  const image = active.build.imageTag;
  if (active.build.status !== BuildStatus.READY || image === null || image === '') {
    return { redeployed: false, reason: 'NO_IMAGE' };
  }

  // A build in flight will run its own deploy (which already re-applies the
  // current env vars). Redeploying now would race the build runner's deploy, so
  // defer to it.
  const inFlight = await prisma.build.findFirst({
    where: { projectId: opts.projectId, status: { in: IN_FLIGHT_BUILD_STATUSES } },
    select: { id: true },
  });
  if (inFlight !== null) {
    return { redeployed: false, reason: 'BUILD_IN_PROGRESS' };
  }

  const envVars = await loadDecryptedEnvVars(opts.projectId);

  logger.info(
    { projectId: opts.projectId, deploymentId: active.id, image },
    'redeploying current image with updated env vars',
  );

  const deploy = await updateContainerApp({
    name: active.project.containerAppName,
    image,
    envVars,
  });

  try {
    const deployment = await prisma.$transaction(async (tx) => {
      await tx.deployment.updateMany({
        where: { projectId: opts.projectId, active: true },
        data: { active: false },
      });
      const row = await tx.deployment.create({
        data: {
          projectId: opts.projectId,
          buildId: active.buildId,
          revisionName: deploy.revisionName ?? active.revisionName,
          active: true,
          rolledBack: false,
        },
        include: { build: true },
      });
      await tx.project.update({
        where: { id: opts.projectId },
        data: { liveUrl: deploy.liveUrl },
      });
      return row;
    });
    return { redeployed: true, deployment };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new HttpError(
        409,
        'ROLLBACK_CONFLICT',
        'The active deployment changed while redeploying. Please retry.',
      );
    }
    throw err;
  }
}
