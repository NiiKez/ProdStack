import { randomBytes } from 'node:crypto';

import { Prisma } from '@prisma/client';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

import { BuildStatus } from '@prisma/client';

import { prisma } from '../db.js';
import { env } from '../env.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import { HttpError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { buildTriggerLimiter, expensiveLimiter } from '../middleware/rateLimit.js';
import { requireXRequestedWith } from '../middleware/requireXRequestedWith.js';
import {
  createContainerApp,
  deleteContainerApp,
  startContainerApp,
  stopContainerApp,
} from '../services/azure/index.js';
import { getAppMetrics, stubMetrics, type MetricRange } from '../services/azure/metrics.js';
import { queryRuntimeLogs, stubRuntimeLogs } from '../services/azure/logs.js';
import {
  createDemoProject,
  resumeDemoProject,
  rollbackDemoDeployment,
  startDemoBuild,
  stopDemoProject,
} from '../services/demo/demoOrchestrator.js';
import {
  IN_FLIGHT_BUILD_STATUSES,
  redeployWithCurrentEnv,
  rollbackToDeployment,
} from '../services/deploy.js';
import {
  createRepoWebhook,
  deleteRepoWebhook,
  fetchBranchHeadCommit,
  GithubWebhookError,
  octokitForUser,
} from '../services/github.js';
import {
  listPreviews,
  teardownAllForProject,
  teardownPreview,
} from '../services/previews/previewService.js';
import { loadDecryptedEnvVars, loadEnvVarMeta } from '../services/projectEnv.js';
import { recordSecurityEvent } from '../services/securityEvents.js';
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

const METRIC_RANGES = ['1h', '6h', '24h'] as const;
const metricsQuerySchema = z.object({
  range: z.enum(METRIC_RANGES).optional(),
});

const runtimeLogsQuerySchema = z.object({
  // Look-back window for the snapshot; the frontend defaults to 15m.
  sinceMinutes: z.coerce.number().int().positive().max(1440).optional(),
  // Cursor for the auto-refresh "tail": only return lines newer than this ISO ts.
  afterTs: z.string().datetime().optional(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
});

const rollbackParamSchema = z.object({
  id: z.string().min(1).max(40),
  deploymentId: z.string().min(1).max(40),
});

const BUILD_STATUSES = new Set<string>(Object.values(BuildStatus));

const buildsQuerySchema = z.object({
  // Comma-separated BuildStatus values, e.g. `?status=READY,FAILED`.
  status: z.string().max(200).optional(),
  branch: z.string().max(255).optional(),
  sort: z.enum(['created', 'duration']).default('created'),
  order: z.enum(['asc', 'desc']).default('desc'),
  // ISO timestamp lower bound on createdAt (date-range filter).
  since: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(40).optional(),
});

const deploymentsQuerySchema = z.object({
  activeOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(40).optional(),
});

// Git-ref-safe branch name. `branch` flows downstream into `git clone --branch`,
// so reject anything that could be read as a flag (leading `-`), break out of
// the ref (`..`, whitespace, control chars), or fall outside a conservative
// safe charset. Keeps the existing length bounds.
const BRANCH_NAME_RE = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]+$/;
const branchSchema = z.string().min(1).max(255).regex(BRANCH_NAME_RE, 'invalid branch name');

const createBodySchema = z.object({
  repoUrl: z.string().min(1).max(2048),
  branch: branchSchema.optional(),
  name: z.string().min(1).max(50),
});

const patchBodySchema = z.object({
  branch: branchSchema.optional(),
  name: z.string().min(1).max(50).optional(),
  autoDeploy: z.boolean().optional(),
  previewsEnabled: z.boolean().optional(),
  envVars: z
    .array(
      z.object({
        key: z
          .string()
          .min(1)
          .max(128)
          .regex(ENV_KEY_RE, 'env var keys must match ^[A-Z_][A-Z0-9_]*$'),
        // Write-only: values are never returned to the client, so on save the
        // client only sends a value for keys it actually edited/added. An
        // omitted (or null) value means "keep the currently-stored encrypted
        // value for this key". A key absent from the submitted list is deleted.
        // Adding a brand-new key with no value is rejected (nothing to keep) —
        // enforced in the handler since the schema can't see existing keys.
        value: z.string().max(MAX_ENV_VALUE_BYTES).nullable().optional(),
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
        commitMessage: latest.commitMessage,
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
    autoDeploy: project.autoDeploy,
    previewsEnabled: project.previewsEnabled,
    status: project.status,
    stoppedAt: project.stoppedAt,
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
      commitMessage: b.commitMessage,
      commitAuthor: b.commitAuthor,
      branch: b.branch,
      startedAt: b.startedAt,
      finishedAt: b.finishedAt,
      durationMs: b.durationMs,
      createdAt: b.createdAt,
    }));
  }

  return base;
}

interface BuildRow {
  id: string;
  status: BuildStatus;
  commitSha: string;
  commitMessage: string;
  commitAuthor: string;
  branch: string;
  imageTag: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  durationMs: number | null;
  errorMessage: string | null;
  createdAt: Date;
}

function serializeBuildRow(b: BuildRow) {
  return {
    id: b.id,
    status: b.status,
    commitSha: b.commitSha,
    commitMessage: b.commitMessage,
    commitAuthor: b.commitAuthor,
    branch: b.branch,
    imageTag: b.imageTag,
    startedAt: b.startedAt,
    finishedAt: b.finishedAt,
    durationMs: b.durationMs,
    errorMessage: b.errorMessage,
    createdAt: b.createdAt,
  };
}

function serializeDeploymentRow(d: {
  id: string;
  revisionName: string;
  active: boolean;
  rolledBack: boolean;
  createdAt: Date;
  build: BuildRow;
}) {
  return {
    id: d.id,
    revisionName: d.revisionName,
    active: d.active,
    rolledBack: d.rolledBack,
    createdAt: d.createdAt,
    build: {
      id: d.build.id,
      status: d.build.status,
      commitSha: d.build.commitSha,
      commitMessage: d.build.commitMessage,
      commitAuthor: d.build.commitAuthor,
      branch: d.build.branch,
      imageTag: d.build.imageTag,
    },
  };
}

/** Parse a `?status=A,B` filter into a list of valid BuildStatus values. */
function parseStatusFilter(raw: string | undefined): BuildStatus[] | undefined {
  if (raw === undefined) return undefined;
  const values = raw
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => BUILD_STATUSES.has(s)) as BuildStatus[];
  return values.length > 0 ? values : undefined;
}

/**
 * Look up a live project owned by `userId`, throwing 404 otherwise. Shared by
 * the per-project sub-resource routes so each one enforces ownership before
 * touching builds/deployments.
 */
async function requireOwnedProject(id: string, userId: string) {
  const project = await prisma.project.findFirst({
    where: { id, userId, deletedAt: null },
  });
  if (project === null) {
    throw new HttpError(404, 'PROJECT_NOT_FOUND');
  }
  return project;
}

/**
 * Resolve the commit to build for a project: prefer the live branch head from
 * GitHub, fall back to the project's most recent stored build if GitHub is
 * unreachable (token revoked, repo gone, transient API error). Returns null when
 * no commit can be determined at all. Shared by manual rebuild and resume — for
 * resume this naturally picks the NEWEST commit, so pushes ignored while the
 * project was stopped converge to the current head (intermediate commits are
 * skipped — only the branch tip matters). Throws HttpError(401) only if the
 * authenticated user row has vanished.
 */
async function resolveLatestCommit(
  project: { id: string; githubRepoFullName: string; branch: string },
  userId: string,
): Promise<{ sha: string; message: string; author: string } | null> {
  let commit: { sha: string; message: string; author: string } | null = null;
  const [owner, repo] = project.githubRepoFullName.split('/');
  if (owner !== undefined && repo !== undefined) {
    try {
      const userRow = await prisma.user.findUnique({ where: { id: userId } });
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
      commit = await fetchBranchHeadCommit(octokit, { owner, repo, ref: project.branch });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      logger.warn(
        { err, projectId: project.id, repo: project.githubRepoFullName },
        'commit lookup failed; falling back to last build',
      );
    }
  }

  if (commit === null) {
    const lastBuild = await prisma.build.findFirst({
      where: { projectId: project.id },
      orderBy: { createdAt: 'desc' },
    });
    if (lastBuild !== null) {
      commit = {
        sha: lastBuild.commitSha,
        message: lastBuild.commitMessage,
        author: lastBuild.commitAuthor,
      };
    }
  }

  return commit;
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

      // Demo sessions: dispatch to the DB-only orchestrator BEFORE any GitHub
      // (`octokitForUser`) or Azure (`createContainerApp`) call — the demo
      // session is structurally unable to reach a real external service
      // (docs/DEMO_MODE.md §4 layer 3). The orchestrator creates the project +
      // kicks a replay build; we re-fetch + reshape so the HTTP response is
      // byte-identical to a real create.
      if (req.user?.isDemo === true) {
        const { projectId } = await createDemoProject(
          { id: user.id, githubLogin: user.githubLogin },
          { name: body.name, repoUrl: body.repoUrl, ...(body.branch ? { branch: body.branch } : {}) },
        );
        const created = await prisma.project.findUniqueOrThrow({
          where: { id: projectId },
          include: projectWithRelations.include,
        });
        res.status(201).json(reshapeProject(created));
        return;
      }

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

      // One live project per GitHub repo among real (non-demo) users — the
      // webhook handler routes a delivery to its project by `githubRepoId`, so
      // two live projects on the same repo would make HMAC verification
      // non-deterministic (dropped deploys / a build queued under the wrong
      // owner). The DB partial unique index `project_repo_live_real` is the hard
      // backstop (a P2002 surfaces as a clean 409 via the error middleware);
      // this pre-check returns a friendly, specific error instead.
      const existingForRepo = await prisma.project.findFirst({
        where: { githubRepoId: repoData.id, deletedAt: null, isDemo: false },
        select: { id: true },
      });
      if (existingForRepo !== null) {
        throw new HttpError(409, 'REPO_ALREADY_CONNECTED');
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
        // `default_branch` comes from the GitHub API, not the request body, so
        // it skips createBodySchema. Run it through branchSchema anyway — it
        // flows to `git clone --branch` like any user-supplied branch.
        const branch = branchSchema.parse(body.branch ?? repoData.default_branch ?? 'main');

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
              // Denormalized from the owning user (false for real users — this
              // path only runs for non-demo users; demo creates dispatch to the
              // orchestrator earlier). Feeds the project_repo_live_real index.
              isDemo: userRow.isDemo,
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

      // Audit the project creation (keys-only: slug + repo id, no secrets).
      await recordSecurityEvent({
        action: 'project.created',
        outcome: 'success',
        userId: user.id,
        targetType: 'project',
        targetId: created.id,
        ip: req.ip ?? null,
        metadata: { slug: created.slug, githubRepoId: created.githubRepoId },
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
    // Write-only secret values: never return a decrypted value in the response
    // body. The client gets each key plus `hasValue` and renders a masked
    // placeholder; replacing a value requires submitting a new one via PATCH.
    const envVars = await loadEnvVarMeta(project.id);
    res.json({
      ...reshapeProject(project, { allBuilds: true }),
      envVars,
    });
  } catch (err) {
    next(err);
  }
});

// --- GET /:id/metrics (Azure Monitor: cpu/mem/replicas/requests) -----------

router.get('/:id/metrics', expensiveLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = idParamSchema.parse(req.params);
    const user = getUser(req);
    const q = metricsQuerySchema.parse(req.query);
    const project = await requireOwnedProject(id, user.id);

    const range: MetricRange = q.range ?? '1h';
    // Demo projects have no real Azure resource to query, so synthesize a series
    // from the stub generator regardless of AZURE_STUB (docs/DEMO_MODE.md §6.5).
    const metrics =
      req.user?.isDemo === true
        ? stubMetrics({ containerAppName: project.containerAppName, range })
        : await getAppMetrics({ containerAppName: project.containerAppName, range });
    res.json(metrics);
  } catch (err) {
    next(err);
  }
});

// --- GET /:id/runtime/logs (the running app's stdout/stderr) ---------------
// Snapshot of the live container's console logs from Log Analytics. The
// frontend auto-refreshes on an interval (passing `afterTs` to tail only new
// lines). The service degrades gracefully — `available:false` + a note rather
// than a 500 — when the workspace isn't configured or the query fails.

router.get('/:id/runtime/logs', expensiveLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = idParamSchema.parse(req.params);
    const user = getUser(req);
    const q = runtimeLogsQuerySchema.parse(req.query);
    const project = await requireOwnedProject(id, user.id);

    const logsOpts = {
      containerAppName: project.containerAppName,
      ...(q.sinceMinutes !== undefined ? { sinceMinutes: q.sinceMinutes } : {}),
      ...(q.afterTs !== undefined ? { afterTs: q.afterTs } : {}),
      ...(q.limit !== undefined ? { limit: q.limit } : {}),
    };
    // Demo projects have no real Log Analytics data, so synthesize lines from
    // the stub generator regardless of AZURE_STUB (docs/DEMO_MODE.md §6.5).
    const result =
      req.user?.isDemo === true ? stubRuntimeLogs(logsOpts) : await queryRuntimeLogs(logsOpts);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// --- GET /:id/builds (paginated, filterable, sortable) ---------------------

router.get('/:id/builds', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = idParamSchema.parse(req.params);
    const user = getUser(req);
    const q = buildsQuerySchema.parse(req.query);
    await requireOwnedProject(id, user.id);

    const statuses = parseStatusFilter(q.status);
    const where: Prisma.BuildWhereInput = { projectId: id };
    if (statuses) where.status = { in: statuses };
    if (q.branch) where.branch = q.branch;
    if (q.since) where.createdAt = { gte: new Date(q.since) };

    // Keyset pagination: order by the chosen field with `id` as a stable
    // tiebreaker, continue strictly after the cursor row. `take: limit + 1`
    // peeks one past the page to compute `nextCursor` without a count query.
    const orderBy: Prisma.BuildOrderByWithRelationInput[] =
      q.sort === 'duration'
        ? [{ durationMs: q.order }, { id: 'desc' }]
        : [{ createdAt: q.order }, { id: 'desc' }];

    const rows = await prisma.build.findMany({
      where,
      orderBy,
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > q.limit;
    const items = hasMore ? rows.slice(0, q.limit) : rows;
    res.json({
      items: items.map(serializeBuildRow),
      nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
    });
  } catch (err) {
    next(err);
  }
});

// --- GET /:id/deployments (paginated) --------------------------------------

router.get('/:id/deployments', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = idParamSchema.parse(req.params);
    const user = getUser(req);
    const q = deploymentsQuerySchema.parse(req.query);
    await requireOwnedProject(id, user.id);

    const where: Prisma.DeploymentWhereInput = { projectId: id };
    if (q.activeOnly) where.active = true;

    const rows = await prisma.deployment.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
      include: { build: true },
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > q.limit;
    const items = hasMore ? rows.slice(0, q.limit) : rows;
    res.json({
      items: items.map(serializeDeploymentRow),
      nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
    });
  } catch (err) {
    next(err);
  }
});

// --- Preview / PR environments ---------------------------------------------

const previewParamSchema = z.object({
  id: z.string().min(1).max(40),
  previewId: z.string().min(1).max(40),
});

function serializePreview(p: {
  id: string;
  prNumber: number;
  title: string;
  headRef: string;
  headSha: string;
  authorLogin: string;
  status: string;
  liveUrl: string | null;
  lastBuildId: string | null;
  expiresAt: Date;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: p.id,
    prNumber: p.prNumber,
    title: p.title,
    headRef: p.headRef,
    headSha: p.headSha,
    authorLogin: p.authorLogin,
    status: p.status,
    liveUrl: p.liveUrl,
    lastBuildId: p.lastBuildId,
    expiresAt: p.expiresAt,
    closedAt: p.closedAt,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

// GET /:id/previews — list this project's preview environments (open first by
// recency). Demo projects never have previews (no real PRs), so this is just an
// empty list for a demo session.
router.get('/:id/previews', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = idParamSchema.parse(req.params);
    const user = getUser(req);
    await requireOwnedProject(id, user.id);
    const previews = await listPreviews(id);
    res.json({ previews: previews.map(serializePreview) });
  } catch (err) {
    next(err);
  }
});

// POST /:id/previews/:previewId/teardown — manually tear down a preview (delete
// its Container App + mark TORN_DOWN). Idempotent.
router.post(
  '/:id/previews/:previewId/teardown',
  requireXRequestedWith,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id, previewId } = previewParamSchema.parse(req.params);
      const user = getUser(req);
      await requireOwnedProject(id, user.id);

      // Demo sessions have no real previews / Container Apps — never reach Azure.
      if (req.user?.isDemo === true) {
        throw new HttpError(403, 'DEMO_NOT_SUPPORTED', 'Preview environments are not available in the demo.');
      }

      // Scope the preview to the owned project so one user can't tear down
      // another's preview by guessing an id.
      const preview = await prisma.previewEnvironment.findFirst({
        where: { id: previewId, projectId: id },
      });
      if (preview === null) {
        throw new HttpError(404, 'PREVIEW_NOT_FOUND');
      }

      await teardownPreview(preview.id);
      const fresh = await prisma.previewEnvironment.findUniqueOrThrow({ where: { id: preview.id } });
      res.json(serializePreview(fresh));
    } catch (err) {
      next(err);
    }
  },
);

// --- POST /:id/deployments/:deploymentId/rollback --------------------------

router.post(
  '/:id/deployments/:deploymentId/rollback',
  requireXRequestedWith,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id, deploymentId } = rollbackParamSchema.parse(req.params);
      const user = getUser(req);

      // Demo sessions: roll back DB-only via the orchestrator BEFORE the real
      // `rollbackToDeployment` → `updateContainerApp` (Azure) call — a demo
      // project has no real Container App, so the real path would issue a live
      // ARM request for a demo session (CORE INVARIANT breach, docs/DEMO_MODE.md
      // §4 layer 3). Same guards/response shape as the real path.
      if (req.user?.isDemo === true) {
        const demoDeployment = await rollbackDemoDeployment({
          projectId: id,
          deploymentId,
          userId: user.id,
        });
        res.status(201).json(serializeDeploymentRow(demoDeployment));
        return;
      }

      // Ownership is enforced inside the service (scoped to the user's live
      // project), which also 404s a foreign/unknown deployment.
      const deployment = await rollbackToDeployment({
        projectId: id,
        deploymentId,
        userId: user.id,
      });
      res.status(201).json(serializeDeploymentRow(deployment));
    } catch (err) {
      next(err);
    }
  },
);

// --- POST /:id/rebuild (manual rebuild of the current branch head) ---------

router.post(
  '/:id/rebuild',
  buildTriggerLimiter,
  requireXRequestedWith,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = idParamSchema.parse(req.params);
      const user = getUser(req);
      const project = await requireOwnedProject(id, user.id);

      // Kill switch (degrade mode): refuse to enqueue new builds while the
      // platform is paused for cost reasons. Existing deployed apps keep
      // serving; only new build creation is blocked. `Retry-After` mirrors the
      // webhook path (webhooks.ts) so both 503s carry the same machine retry hint.
      if (env.KILL_SWITCH) {
        res.set('Retry-After', '86400');
        throw new HttpError(503, 'BUILDS_PAUSED', 'Builds are temporarily paused (usage limit).');
      }

      // A stopped project is paused — don't build something that isn't running.
      // The owner must resume it first (resume optionally auto-builds the head).
      if (project.status === 'STOPPED') {
        throw new HttpError(
          409,
          'PROJECT_STOPPED',
          'This project is stopped. Resume it before triggering a build.',
        );
      }

      // One build at a time per project: a concurrent in-flight build already
      // owns the deploy, so a second one would race it. This check + insert is
      // not atomic (no serializable tx / unique index), so two near-simultaneous
      // rebuilds — or a rebuild racing a webhook push — can both enqueue. That's
      // accepted: the single-replica worker claims QUEUED rows one at a time
      // (FOR UPDATE SKIP LOCKED), so they run sequentially rather than racing the
      // same deploy, and the single-user gate makes the window vanishingly rare.
      const inFlight = await prisma.build.findFirst({
        where: { projectId: project.id, status: { in: IN_FLIGHT_BUILD_STATUSES } },
        select: { id: true },
      });
      if (inFlight !== null) {
        throw new HttpError(409, 'BUILD_IN_PROGRESS', 'A build is already running for this project.');
      }

      // Demo sessions: enqueue a pre-claimed replay build via the orchestrator
      // BEFORE the GitHub commit-lookup block (`octokitForUser`/
      // `fetchBranchHeadCommit`) — no real GitHub call (docs/DEMO_MODE.md §4
      // layer 3). The KILL_SWITCH + in-flight guards above are DB-only and still
      // apply to demo (harmless, keeps behavior uniform).
      if (req.user?.isDemo === true) {
        const { buildId } = await startDemoBuild({
          id: project.id,
          branch: project.branch,
          githubRepoFullName: project.githubRepoFullName,
        });
        res.status(202).json({ buildId });
        return;
      }

      // Resolve the commit to build (live branch head, falling back to the last
      // stored build). Shared with the resume route's auto-build.
      const commit = await resolveLatestCommit(project, user.id);

      if (commit === null) {
        throw new HttpError(
          400,
          'NO_COMMIT_AVAILABLE',
          'Could not determine a commit to build. Push to the repo first.',
        );
      }

      const build = await prisma.build.create({
        data: {
          projectId: project.id,
          commitSha: commit.sha,
          commitMessage: commit.message,
          commitAuthor: commit.author,
          branch: project.branch,
          status: 'QUEUED',
        },
        select: { id: true },
      });

      logger.info(
        { projectId: project.id, buildId: build.id, commitSha: commit.sha },
        'manual rebuild queued',
      );
      res.status(202).json({ buildId: build.id });
    } catch (err) {
      next(err);
    }
  },
);

// --- POST /:id/stop (pause the deployed app — Azure stop, $0 compute) ------

router.post(
  '/:id/stop',
  requireXRequestedWith,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = idParamSchema.parse(req.params);
      const user = getUser(req);
      const project = await requireOwnedProject(id, user.id);

      // Demo sessions: DB-only flip via the orchestrator (no Azure). It owns its
      // own idempotent + in-flight guards (docs/DEMO_MODE.md §4 layer 3).
      if (req.user?.isDemo === true) {
        await stopDemoProject(id, user.id);
        const fresh = await prisma.project.findUniqueOrThrow({
          where: { id },
          include: projectWithRelations.include,
        });
        res.json(reshapeProject(fresh));
        return;
      }

      // Idempotent: already stopped → return current shape, no Azure call.
      if (project.status !== 'STOPPED') {
        // Reject while a build is in-flight: that build will deploy (a new active
        // revision via updateContainerApp) and silently undo the stop. Make the
        // owner wait for it to finish, then stop cleanly.
        const inFlight = await prisma.build.findFirst({
          where: { projectId: project.id, status: { in: IN_FLIGHT_BUILD_STATUSES } },
          select: { id: true },
        });
        if (inFlight !== null) {
          throw new HttpError(
            409,
            'BUILD_IN_PROGRESS',
            'A build is running for this project. Wait for it to finish before stopping.',
          );
        }

        // Stop the Azure Container App FIRST; only flip the DB if Azure succeeds,
        // so a failed stop leaves the project ACTIVE. Surface an upstream Azure
        // failure as a 502 (not a generic 500) so the client can distinguish
        // "Azure is down, retry" from a real server fault.
        try {
          await stopContainerApp(project.containerAppName);
        } catch (err) {
          logger.error({ err, projectId: project.id }, 'azure stop failed');
          throw new HttpError(
            502,
            'AZURE_STOP_FAILED',
            'Failed to stop the app on Azure. The project is still active — try again.',
          );
        }
        await prisma.project.update({
          where: { id },
          data: { status: 'STOPPED', stoppedAt: new Date() },
        });
        logger.info({ projectId: project.id }, 'project stopped');
      }

      const fresh = await prisma.project.findUniqueOrThrow({
        where: { id },
        include: projectWithRelations.include,
      });
      res.json(reshapeProject(fresh));
    } catch (err) {
      next(err);
    }
  },
);

// --- POST /:id/resume (start the app; optionally build the newest commit) ---

router.post(
  '/:id/resume',
  requireXRequestedWith,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = idParamSchema.parse(req.params);
      const user = getUser(req);
      const project = await requireOwnedProject(id, user.id);

      // Demo sessions: DB-only flip, never auto-builds (no real git head).
      if (req.user?.isDemo === true) {
        await resumeDemoProject(id, user.id);
        const fresh = await prisma.project.findUniqueOrThrow({
          where: { id },
          include: projectWithRelations.include,
        });
        res.json({ ...reshapeProject(fresh), resumedBuild: null });
        return;
      }

      let resumedBuild: { id: string } | null = null;

      if (project.status === 'STOPPED') {
        // Start the Azure Container App FIRST; only flip the DB if it succeeds.
        // A 502 (not a generic 500) on upstream Azure failure lets the client
        // tell "Azure is down, retry" apart from a real server fault.
        try {
          await startContainerApp(project.containerAppName);
        } catch (err) {
          logger.error({ err, projectId: project.id }, 'azure start failed');
          throw new HttpError(
            502,
            'AZURE_START_FAILED',
            'Failed to start the app on Azure. The project is still stopped — try again.',
          );
        }
        await prisma.project.update({
          where: { id },
          data: { status: 'ACTIVE', stoppedAt: null },
        });
        logger.info({ projectId: project.id }, 'project resumed');

        // If auto-deploy is on, build the NEWEST commit so the resumed app
        // converges to the current branch head — pushes made while stopped were
        // ignored, and only the tip matters. Best-effort: the app is already back
        // up on its last image, so a failed/absent build never fails the resume.
        //
        // The status is already ACTIVE here, so a webhook racing this enqueue is
        // no longer gated and could create a second build — the same benign,
        // single-replica-serialized race accepted for /rebuild above (the worker
        // claims one at a time; the single-user gate makes the window vanishing).
        if (project.autoDeploy && !env.KILL_SWITCH) {
          try {
            const inFlight = await prisma.build.findFirst({
              where: { projectId: project.id, status: { in: IN_FLIGHT_BUILD_STATUSES } },
              select: { id: true },
            });
            if (inFlight === null) {
              const commit = await resolveLatestCommit(project, user.id);
              if (commit !== null) {
                const build = await prisma.build.create({
                  data: {
                    projectId: project.id,
                    commitSha: commit.sha,
                    commitMessage: commit.message,
                    commitAuthor: commit.author,
                    branch: project.branch,
                    status: 'QUEUED',
                  },
                  select: { id: true },
                });
                resumedBuild = { id: build.id };
                logger.info(
                  { projectId: project.id, buildId: build.id, commitSha: commit.sha },
                  'resume queued latest-commit build',
                );
              }
            }
          } catch (err) {
            logger.warn(
              { err, projectId: project.id },
              'resume: auto-build of latest commit failed (app is up; non-fatal)',
            );
          }
        }
      }

      const fresh = await prisma.project.findUniqueOrThrow({
        where: { id },
        include: projectWithRelations.include,
      });
      res.json({ ...reshapeProject(fresh), resumedBuild });
    } catch (err) {
      next(err);
    }
  },
);

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
      if (body.autoDeploy !== undefined) updates.autoDeploy = body.autoDeploy;
      if (body.previewsEnabled !== undefined) updates.previewsEnabled = body.previewsEnabled;

      // When env vars are submitted, diff the desired set against what's stored
      // so we only trigger a config-only redeploy when something actually
      // changed (no-op saves shouldn't roll a new Azure revision).
      //
      // Values are write-only (the client never receives them), so the payload
      // carries a value only for keys the user actually edited/added; an omitted
      // value means "keep the stored value". We resolve the desired final set by
      // overlaying the submitted values on top of the existing ones, then diff
      // that against what's stored.
      const envVarsProvided = body.envVars !== undefined && body.envVars !== null;
      let envVarsChanged = false;
      // The exact set of env-var KEYS that changed (added / edited / removed) —
      // keys only, never values. Reused for the redeploy gate and the audit
      // event written after the save commits.
      const changedEnvKeys: string[] = [];
      // The desired final value for each submitted key: a fresh value to encrypt,
      // or `undefined` to signal "keep the stored ciphertext untouched". Built
      // once here (it needs the decrypted existing set) and reused in the tx.
      const desiredEnvValues = new Map<string, string | undefined>();
      if (envVarsProvided) {
        const existing = await loadDecryptedEnvVars(project.id);
        const desired = body.envVars!;
        const existingMap = new Map(existing.map((e) => [e.name, e.value]));

        // Reject up front: a brand-new key (not currently stored) with no value
        // has nothing to keep. Duplicate keys are rejected inside the tx, but do
        // it here too so this map is built from a clean, de-duped set.
        const seen = new Set<string>();
        for (const entry of desired) {
          if (seen.has(entry.key)) {
            throw new HttpError(400, 'DUPLICATE_ENV_KEY', `duplicate env key: ${entry.key}`);
          }
          seen.add(entry.key);
          const hasNewValue = entry.value !== undefined && entry.value !== null;
          // An explicit empty-string value is never valid: it would silently
          // overwrite a stored secret with "" (the client can't see the value it
          // would be clobbering). Omit the value to keep the stored one; remove
          // the key to delete the var. Covers both new and stored-edited keys.
          if (entry.value === '') {
            throw new HttpError(
              400,
              'ENV_VALUE_REQUIRED',
              `value must not be empty for env var: ${entry.key} (omit the value to keep it, or remove the key to delete it)`,
            );
          }
          if (!hasNewValue && !existingMap.has(entry.key)) {
            throw new HttpError(
              400,
              'ENV_VALUE_REQUIRED',
              `a value is required for new env var: ${entry.key}`,
            );
          }
          desiredEnvValues.set(entry.key, hasNewValue ? entry.value! : undefined);
        }

        // Structural diff by (key → final value): collect the exact KEYS that
        // changed. Removed = stored key not resubmitted; added = submitted key
        // not stored; edited = submitted key with a new value that differs. A
        // kept value (no new value submitted) matches the existing one by
        // definition, so it never marks the set as changed.
        for (const key of existingMap.keys()) {
          if (!desiredEnvValues.has(key)) changedEnvKeys.push(key); // removed
        }
        for (const [key, newValue] of desiredEnvValues) {
          if (!existingMap.has(key)) {
            changedEnvKeys.push(key); // added
          } else if (newValue !== undefined && existingMap.get(key) !== newValue) {
            changedEnvKeys.push(key); // edited
          }
        }
        envVarsChanged = changedEnvKeys.length > 0;
      }

      const refreshed = await prisma.$transaction(async (tx) => {
        if (Object.keys(updates).length > 0) {
          await tx.project.update({ where: { id: project.id }, data: updates });
        }

        if (envVarsProvided) {
          // `desiredEnvValues` was built above (deduped + validated): each key
          // maps to a fresh value to encrypt, or `undefined` to keep the stored
          // ciphertext untouched. Keys absent from the map are deleted.
          const submittedKeys = Array.from(desiredEnvValues.keys());

          if (submittedKeys.length === 0) {
            await tx.envVar.deleteMany({ where: { projectId: project.id } });
          } else {
            await tx.envVar.deleteMany({
              where: {
                projectId: project.id,
                key: { notIn: submittedKeys },
              },
            });
          }

          for (const [key, newValue] of desiredEnvValues) {
            // `undefined` → the user didn't submit a new value, so keep the
            // currently-stored encrypted value: skip the write entirely. This is
            // what makes the write-only contract safe — the client can save the
            // project without ever holding (or being able to wipe) the secret.
            if (newValue === undefined) continue;
            const enc = encrypt(newValue);
            await tx.envVar.upsert({
              where: { projectId_key: { projectId: project.id, key } },
              create: {
                projectId: project.id,
                key,
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
          // Stored encrypted here; surfaced to the Container App as secrets on
          // the next deploy via `loadDecryptedEnvVars`. A config-only change now
          // auto-triggers a redeploy of the current image after this tx commits
          // (see `redeployWithCurrentEnv` below), so saving env vars goes live
          // without requiring a git push.
        }

        return tx.project.findFirstOrThrow({
          where: { id: project.id },
          include: projectWithRelations.include,
        });
      });

      // Audit a successful env-var change — the save tx has committed. Record the
      // CHANGED KEYS ONLY (added/edited/removed), never the values. A no-op save
      // (no keys changed) isn't audited.
      if (envVarsProvided && changedEnvKeys.length > 0) {
        await recordSecurityEvent({
          action: 'env.updated',
          outcome: 'success',
          userId: user.id,
          targetType: 'project',
          targetId: project.id,
          ip: req.ip ?? null,
          metadata: {
            changedKeys: [...changedEnvKeys].sort(),
            count: changedEnvKeys.length,
          },
        });
      }

      // After the save commits, redeploy the current image with the new env
      // vars so the change is live immediately. This is best-effort: the env
      // vars are already persisted, so a redeploy failure (including a 4xx like
      // ROLLBACK_CONFLICT) is reported in the response but never fails the save.
      let redeploySummary: { redeployed: boolean; reason?: string } | undefined;
      if (envVarsProvided) {
        if (req.user?.isDemo === true) {
          // Demo sessions never trigger a real redeploy (`redeployWithCurrentEnv`
          // → Azure); the env-var rows are persisted in the tx above, which is
          // all a demo needs (docs/DEMO_MODE.md §4 layer 3).
          redeploySummary = { redeployed: false, reason: 'DEMO' };
        } else if (!envVarsChanged) {
          // Nothing changed → nothing to roll.
          redeploySummary = { redeployed: false };
        } else {
          try {
            const result = await redeployWithCurrentEnv({
              projectId: project.id,
              userId: user.id,
            });
            redeploySummary = result.reason
              ? { redeployed: result.redeployed, reason: result.reason }
              : { redeployed: result.redeployed };
          } catch (err) {
            logger.warn(
              { err, projectId: project.id },
              'redeploy after env-var save failed; env vars saved, redeploy skipped',
            );
            redeploySummary = { redeployed: false, reason: 'REDEPLOY_FAILED' };
          }
        }
      }

      // When env vars were saved, return the refreshed masked set ({key,hasValue})
      // so the client can re-sync its editor — values stay write-only, never
      // echoed back.
      const envVarsResult = envVarsProvided ? await loadEnvVarMeta(project.id) : undefined;

      res.json({
        ...reshapeProject(refreshed, { allBuilds: true }),
        ...(envVarsResult ? { envVars: envVarsResult } : {}),
        ...(redeploySummary ? { redeploy: redeploySummary } : {}),
      });
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

      // Demo projects have no real Azure resource and no real webhook (their
      // `webhookId` is always null), so a demo delete is DB-only: skip both the
      // Azure `deleteContainerApp` and the GitHub `deleteRepoWebhook`/
      // `octokitForUser` calls entirely (docs/DEMO_MODE.md §4 layer 3).
      const isDemo = req.user?.isDemo === true;

      if (!isDemo) {
        try {
          await deleteContainerApp(project.containerAppName);
        } catch (err) {
          logger.warn(
            { err, containerAppName: project.containerAppName },
            'deleteContainerApp failed during project delete',
          );
        }

        // Tear down any open preview environments too. We're about to remove the
        // webhook, so no future `pull_request closed` delivery can reclaim them —
        // without this their per-PR Container Apps keep serving public URLs until
        // the TTL reaper (or forever if cleanup jobs are off). Best-effort.
        try {
          const torn = await teardownAllForProject(project.id);
          if (torn > 0) {
            logger.info({ projectId: project.id, torn }, 'tore down open previews on project delete');
          }
        } catch (err) {
          logger.warn({ err, projectId: project.id }, 'preview teardown failed during project delete');
        }
      }

      // Unregister the webhook last. We've already soft-deleted the project, so
      // failing here would leave the DB in a worse state than a stale hook.
      if (!isDemo && project.webhookId !== null) {
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
 *
 * Retry ONLY on the slug index. A P2002 on `project_repo_live_real`
 * (githubRepoId) means a concurrent create already claimed this repo — retrying
 * is futile (the repo stays taken) and would re-provision the Container App +
 * re-register the GitHub webhook a second time before failing again. Let that
 * one propagate (it surfaces as a clean 409 via the error middleware).
 */
function isSlugCollision(err: Prisma.PrismaClientKnownRequestError): boolean {
  const target = err.meta?.target;
  if (Array.isArray(target)) return target.includes('slug');
  return typeof target === 'string' && target.includes('slug');
}

async function createWithSlugRetry<T>(attempt: () => Promise<T>): Promise<T> {
  try {
    return await attempt();
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002' &&
      isSlugCollision(err)
    ) {
      return attempt();
    }
    throw err;
  }
}

export default router;
