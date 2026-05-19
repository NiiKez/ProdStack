import { randomBytes } from 'node:crypto';

import { Prisma } from '@prisma/client';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

import { prisma } from '../db.js';
import { env } from '../env.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import { HttpError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { requireXRequestedWith } from '../middleware/requireXRequestedWith.js';
import { createContainerApp, deleteContainerApp } from '../services/azure/index.js';
import {
  createRepoWebhook,
  deleteRepoWebhook,
  GithubWebhookError,
  octokitForUser,
} from '../services/github.js';
import { containerAppName, dedupedSlug, slugify } from '../services/slug.js';

const router = Router();

const REPO_URL_RE = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;

// Posix `name` is `[a-zA-Z_]+[a-zA-Z0-9_]*`. We require uppercase first-letter
// to match the convention every host platform uses, and to avoid collisions
// with system-injected lowercase vars (`PATH`, `HOME` …).
const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]*$/;
const MAX_ENV_VARS_PER_PROJECT = 100;
const MAX_ENV_VALUE_BYTES = 32 * 1024;

const idParamSchema = z.object({ id: z.string().min(1).max(40) });

const createBodySchema = z.object({
  repoUrl: z.string().min(1).max(2048),
  branch: z.string().min(1).max(255).optional(),
  name: z.string().min(1).max(50),
});

const patchBodySchema = z.object({
  branch: z.string().min(1).max(255).optional(),
  name: z.string().min(1).max(50).optional(),
  envVars: z
    .array(
      z.object({
        key: z
          .string()
          .min(1)
          .max(128)
          .regex(ENV_KEY_RE, 'env var keys must match ^[A-Z_][A-Z0-9_]*$'),
        value: z.string().max(MAX_ENV_VALUE_BYTES),
      }),
    )
    .max(MAX_ENV_VARS_PER_PROJECT)
    .nullable()
    .optional(),
});

interface AuthedUser {
  id: string;
  githubLogin: string;
}

function getUser(req: Request): AuthedUser {
  const user = req.user;
  if (
    user === null ||
    user === undefined ||
    typeof user.id !== 'string' ||
    typeof user.githubLogin !== 'string'
  ) {
    throw new HttpError(401, 'UNAUTHENTICATED');
  }
  return { id: user.id, githubLogin: user.githubLogin };
}

function parseRepoUrl(repoUrl: string): { owner: string; repo: string } {
  const match = REPO_URL_RE.exec(repoUrl.trim());
  if (match === null) {
    throw new HttpError(400, 'INVALID_REPO_URL');
  }
  return { owner: match[1]!, repo: match[2]! };
}

const projectWithRelations = Prisma.validator<Prisma.ProjectDefaultArgs>()({
  include: {
    builds: { take: 10, orderBy: { createdAt: 'desc' } },
    deployments: {
      where: { active: true },
      take: 1,
      orderBy: { createdAt: 'desc' },
    },
  },
});

type ProjectWithRelations = Prisma.ProjectGetPayload<typeof projectWithRelations>;

function reshapeProject(project: ProjectWithRelations, opts: { allBuilds?: boolean } = {}) {
  const builds = project.builds;
  const deployments = project.deployments;
  const latest = builds[0];
  const latestBuild = latest
    ? {
        id: latest.id,
        status: latest.status,
        commitSha: latest.commitSha,
        createdAt: latest.createdAt,
      }
    : null;
  const active = deployments[0];
  const activeDeployment = active
    ? {
        id: active.id,
        revisionName: active.revisionName,
        createdAt: active.createdAt,
      }
    : null;

  const base: Record<string, unknown> = {
    id: project.id,
    name: project.name,
    slug: project.slug,
    githubRepoFullName: project.githubRepoFullName,
    githubRepoId: project.githubRepoId,
    branch: project.branch,
    webhookId: project.webhookId,
    containerAppName: project.containerAppName,
    liveUrl: project.liveUrl,
    frameworkHint: project.frameworkHint,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    latestBuild,
    activeDeployment,
  };

  if (opts.allBuilds) {
    base.builds = builds.map((b) => ({
      id: b.id,
      status: b.status,
      commitSha: b.commitSha,
      createdAt: b.createdAt,
    }));
  }

  return base;
}

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = getUser(req);
    const projects = await prisma.project.findMany({
      where: { userId: user.id, deletedAt: null },
      orderBy: { updatedAt: 'desc' },
      include: projectWithRelations.include,
    });
    res.json({ projects: projects.map((p) => reshapeProject(p)) });
  } catch (err) {
    next(err);
  }
});

router.post(
  '/',
  requireXRequestedWith,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = getUser(req);
      const body = createBodySchema.parse(req.body);
      const { owner, repo } = parseRepoUrl(body.repoUrl);

      const userRow = await prisma.user.findUnique({ where: { id: user.id } });
      if (userRow === null) {
        throw new HttpError(401, 'UNAUTHENTICATED');
      }

      const githubToken = decrypt({
        ciphertext: userRow.githubTokenCiphertext,
        iv: userRow.githubTokenIv,
        authTag: userRow.githubTokenAuthTag,
        keyVersion: userRow.githubTokenKeyVersion,
      });

      const octokit = octokitForUser(githubToken);
      let repoData: { id: number; default_branch: string };
      try {
        const response = await octokit.request('GET /repos/{owner}/{repo}', { owner, repo });
        repoData = response.data as { id: number; default_branch: string };
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status === 404) {
          throw new HttpError(404, 'REPO_NOT_ACCESSIBLE');
        }
        logger.warn({ err, owner, repo }, 'github repo lookup failed');
        throw new HttpError(502, 'GITHUB_API_ERROR');
      }

      // Pick a slug that's free among the user's *live* projects so recreating
      // a project with the same name after a soft-delete just works. Retry once
      // on the rare race where two concurrent creates collide on the unique
      // index — by then the other side has committed, so a fresh lookup finds it.
      const created = await createWithSlugRetry(async () => {
        const live = await prisma.project.findMany({
          where: { userId: user.id, deletedAt: null },
          select: { slug: true },
        });
        const slug = dedupedSlug(slugify(body.name), live.map((p) => p.slug));
        const appName = containerAppName(user.githubLogin, slug);
        const branch = body.branch ?? repoData.default_branch ?? 'main';

        const webhookSecret = randomBytes(32).toString('base64');
        const encryptedSecret = encrypt(webhookSecret);

        // Provision the container app first; if the DB insert fails we roll it
        // back. Doing this in the opposite order would require an idempotency
        // marker in Azure to avoid orphans on crash between insert + provision.
        const createResult = await createContainerApp({ name: appName });
        const liveUrl = (createResult as { liveUrl?: string | null }).liveUrl ?? null;

        // Register the push webhook before the DB insert so the persisted
        // `webhookId` is always real. A 422 "Hook already exists" is the one
        // case we tolerate — a previous crashed create left a hook behind, and
        // re-running shouldn't lock the user out of recreating the project.
        let webhookId: number | null = null;
        try {
          const hook = await createRepoWebhook(octokit, {
            owner,
            repo,
            url: `${env.PUBLIC_API_URL}/api/webhooks/github`,
            secret: webhookSecret,
          });
          webhookId = hook.id;
        } catch (err) {
          if (err instanceof GithubWebhookError) {
            const alreadyExists =
              err.status === 422 &&
              err.githubMessage !== undefined &&
              err.githubMessage.includes('Hook already exists');
            if (alreadyExists) {
              logger.warn(
                { owner, repo, githubMessage: err.githubMessage },
                'github webhook already exists; continuing without webhookId',
              );
            } else {
              await rollbackContainerApp(appName);
              if (err.status === 403 || err.status === 404) {
                throw new HttpError(403, 'WEBHOOK_PERMISSION_DENIED');
              }
              logger.warn(
                { err, owner, repo, status: err.status },
                'github webhook create failed',
              );
              throw new HttpError(502, 'GITHUB_API_ERROR');
            }
          } else {
            await rollbackContainerApp(appName);
            throw err;
          }
        }

        try {
          return await prisma.project.create({
            data: {
              userId: user.id,
              name: body.name,
              slug,
              githubRepoFullName: `${owner}/${repo}`,
              githubRepoId: repoData.id,
              branch,
              webhookId,
              webhookSecretCiphertext: encryptedSecret.ciphertext,
              webhookSecretIv: encryptedSecret.iv,
              webhookSecretAuthTag: encryptedSecret.authTag,
              webhookSecretKeyVersion: encryptedSecret.keyVersion,
              containerAppName: appName,
              liveUrl,
            },
            include: projectWithRelations.include,
          });
        } catch (err) {
          if (webhookId !== null) {
            try {
              await deleteRepoWebhook(octokit, { owner, repo, hookId: webhookId });
            } catch (cleanupErr) {
              logger.error(
                { err: cleanupErr, owner, repo, webhookId },
                'failed to clean up webhook after db error',
              );
            }
          }
          await rollbackContainerApp(appName);
          throw err;
        }
      });

      res.status(201).json(reshapeProject(created));
    } catch (err) {
      next(err);
    }
  },
);

router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = idParamSchema.parse(req.params);
    const user = getUser(req);
    const project = await prisma.project.findFirst({
      where: { id, userId: user.id, deletedAt: null },
      include: projectWithRelations.include,
    });
    if (project === null) {
      throw new HttpError(404, 'PROJECT_NOT_FOUND');
    }
    res.json(reshapeProject(project, { allBuilds: true }));
  } catch (err) {
    next(err);
  }
});

router.patch(
  '/:id',
  requireXRequestedWith,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = idParamSchema.parse(req.params);
      const user = getUser(req);
      const body = patchBodySchema.parse(req.body);

      const project = await prisma.project.findFirst({
        where: { id, userId: user.id, deletedAt: null },
      });
      if (project === null) {
        throw new HttpError(404, 'PROJECT_NOT_FOUND');
      }

      const updates: Prisma.ProjectUpdateInput = {};
      if (body.branch !== undefined) updates.branch = body.branch;
      if (body.name !== undefined) updates.name = body.name;

      const refreshed = await prisma.$transaction(async (tx) => {
        if (Object.keys(updates).length > 0) {
          await tx.project.update({ where: { id: project.id }, data: updates });
        }

        if (body.envVars !== undefined && body.envVars !== null) {
          const desired = body.envVars;
          const seen = new Set<string>();
          for (const entry of desired) {
            if (seen.has(entry.key)) {
              throw new HttpError(400, 'DUPLICATE_ENV_KEY', `duplicate env key: ${entry.key}`);
            }
            seen.add(entry.key);
          }

          if (desired.length === 0) {
            await tx.envVar.deleteMany({ where: { projectId: project.id } });
          } else {
            await tx.envVar.deleteMany({
              where: {
                projectId: project.id,
                key: { notIn: Array.from(seen) },
              },
            });
          }

          for (const entry of desired) {
            const enc = encrypt(entry.value);
            await tx.envVar.upsert({
              where: { projectId_key: { projectId: project.id, key: entry.key } },
              create: {
                projectId: project.id,
                key: entry.key,
                valueCiphertext: enc.ciphertext,
                valueIv: enc.iv,
                valueAuthTag: enc.authTag,
                valueKeyVersion: enc.keyVersion,
              },
              update: {
                valueCiphertext: enc.ciphertext,
                valueIv: enc.iv,
                valueAuthTag: enc.authTag,
                valueKeyVersion: enc.keyVersion,
              },
            });
          }
          // TODO M5: trigger redeploy with last successful image
        }

        return tx.project.findFirstOrThrow({
          where: { id: project.id },
          include: projectWithRelations.include,
        });
      });

      res.json(reshapeProject(refreshed, { allBuilds: true }));
    } catch (err) {
      next(err);
    }
  },
);

router.delete(
  '/:id',
  requireXRequestedWith,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = idParamSchema.parse(req.params);
      const user = getUser(req);
      const project = await prisma.project.findFirst({
        where: { id, userId: user.id, deletedAt: null },
      });
      if (project === null) {
        throw new HttpError(404, 'PROJECT_NOT_FOUND');
      }

      await prisma.project.update({
        where: { id: project.id },
        data: { deletedAt: new Date() },
      });

      try {
        await deleteContainerApp(project.containerAppName);
      } catch (err) {
        logger.warn(
          { err, containerAppName: project.containerAppName },
          'deleteContainerApp failed during project delete',
        );
      }

      // Unregister the webhook last. We've already soft-deleted the project, so
      // failing here would leave the DB in a worse state than a stale hook.
      if (project.webhookId !== null) {
        try {
          const userRow = await prisma.user.findUnique({ where: { id: user.id } });
          if (userRow === null) {
            logger.warn({ userId: user.id }, 'user row missing during webhook unregister');
          } else {
            const githubToken = decrypt({
              ciphertext: userRow.githubTokenCiphertext,
              iv: userRow.githubTokenIv,
              authTag: userRow.githubTokenAuthTag,
              keyVersion: userRow.githubTokenKeyVersion,
            });
            const [owner, repo] = project.githubRepoFullName.split('/');
            if (owner === undefined || repo === undefined) {
              logger.warn(
                { fullName: project.githubRepoFullName },
                'unparseable githubRepoFullName during webhook unregister',
              );
            } else {
              const octokit = octokitForUser(githubToken);
              await deleteRepoWebhook(octokit, { owner, repo, hookId: project.webhookId });
            }
          }
        } catch (err) {
          if (err instanceof GithubWebhookError && err.status === 404) {
            logger.info(
              { webhookId: project.webhookId, repo: project.githubRepoFullName },
              'webhook already gone on GitHub; treating delete as idempotent',
            );
          } else {
            logger.warn(
              { err, webhookId: project.webhookId, repo: project.githubRepoFullName },
              'failed to unregister webhook during project delete',
            );
          }
        }
      }

      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);

/** Best-effort container app teardown; swallow errors so the original failure surfaces. */
async function rollbackContainerApp(appName: string): Promise<void> {
  try {
    await deleteContainerApp(appName);
  } catch (cleanupErr) {
    logger.error(
      { err: cleanupErr, appName },
      'failed to clean up container app during rollback',
    );
  }
}

/**
 * Run `attempt` once; if it fails with a unique-constraint collision on
 * (userId, slug) — which only happens when two concurrent creates pick the
 * same slug — retry once. The second pass re-reads the live slug set and
 * picks a different number.
 */
async function createWithSlugRetry<T>(attempt: () => Promise<T>): Promise<T> {
  try {
    return await attempt();
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return attempt();
    }
    throw err;
  }
}

export default router;
