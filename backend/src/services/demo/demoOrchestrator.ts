/**
 * Demo orchestrator — the single module that owns ALL demo write behavior
 * (docs/DEMO_MODE.md §6.2). Keeping every demo mutation in one place keeps the
 * fail-closed boundary auditable: a reviewer reads this one file to confirm a
 * demo session can never reach Azure / ACR / git / Kaniko.
 *
 * CORE INVARIANT (enforced structurally, not by a flag): this module imports NO
 * `services/azure/*`, NO `services/github.js` mutation, NO Kaniko. It writes DB
 * rows directly. The demo build is a REPLAY driven by `demoBuildDriver`. Every
 * function additionally asserts the owning user is `isDemo` (fail-closed layer 4)
 * and creates builds PRE-CLAIMED (layer 1) so the real worker is structurally
 * blind to them.
 */
import { randomBytes } from 'node:crypto';

import { BuildStatus, Prisma } from '@prisma/client';

import { prisma } from '../../db.js';
import { env } from '../../env.js';
import { encrypt } from '../../lib/crypto.js';
import { HttpError } from '../../lib/errors.js';
import { containerAppName, dedupedSlug, slugify } from '../slug.js';
import { startDemoReplay } from './demoBuildDriver.js';
import { SEED_LOG, SEED_PROJECTS, type SeedBuild } from './fixtures/seed-workspace.js';

/** Marks every demo Build's claim so the worker's claim query skips it. */
const DEMO_CLAIMED_BY = 'demo-driver';

/**
 * In-flight build statuses, redeclared locally on purpose: the canonical
 * `IN_FLIGHT_BUILD_STATUSES` lives in `services/deploy.ts`, which imports the
 * Azure SDK — importing it here would breach the orchestrator's "no Azure"
 * invariant (§4). Kept in sync with deploy.ts by hand (both are tiny).
 */
const DEMO_IN_FLIGHT: BuildStatus[] = ['QUEUED', 'CLONING', 'BUILDING', 'PUSHING', 'DEPLOYING'];

/**
 * Assert the user owning a demo write is actually a demo user. This is the §4
 * layer-4 backstop: even if a route mis-branched a real user into the demo path,
 * the orchestrator refuses to act. Loads `isDemo` fresh from the DB rather than
 * trusting the caller's claim.
 */
async function assertDemoUser(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { isDemo: true },
  });
  if (user === null || user.isDemo !== true) {
    throw new Error('demoOrchestrator called for non-demo user');
  }
}

/** A new encrypted random webhook secret (demo projects never register a hook). */
function freshWebhookSecret(): ReturnType<typeof encrypt> {
  return encrypt(randomBytes(32).toString('base64'));
}

/** Stable synthetic positive int repo id derived from a slug (no real GitHub). */
function syntheticRepoId(slug: string): number {
  return (Math.abs([...slug].reduce((a, c) => a * 31 + c.charCodeAt(0), 7)) % 1_000_000) + 1;
}

/** Pad a short hex sha to a full 40-char SHA-1 (matches real build rows). */
function fullSha(short: string): string {
  const clean = short.replace(/[^0-9a-f]/gi, '').toLowerCase() || '0';
  return clean.padEnd(40, clean[0] ?? '0').slice(0, 40);
}

export interface CreateDemoProjectInput {
  name: string;
  repoUrl: string;
  branch?: string;
}

/**
 * Seed a fresh demo session's workspace: 2–3 fake "already deployed" projects
 * (READY builds, an active deployment, env vars, sample log lines) so the
 * dashboard isn't empty. Consumes the typed `SEED_PROJECTS`/`SEED_LOG` fixtures.
 * DB-only — no Azure, no GitHub.
 */
export async function seedDemoWorkspace(userId: string): Promise<void> {
  await assertDemoUser(userId);

  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { githubLogin: true },
  });

  for (const p of SEED_PROJECTS) {
    const wh = freshWebhookSecret();
    const project = await prisma.project.create({
      data: {
        userId,
        name: p.name,
        slug: p.slug,
        githubRepoFullName: p.repo,
        githubRepoId: syntheticRepoId(p.slug),
        branch: 'main',
        webhookId: null,
        webhookSecretCiphertext: wh.ciphertext,
        webhookSecretIv: wh.iv,
        webhookSecretAuthTag: wh.authTag,
        webhookSecretKeyVersion: wh.keyVersion,
        containerAppName: containerAppName(user.githubLogin, p.slug),
        liveUrl: p.live,
        frameworkHint: p.framework,
      },
    });

    for (const [key, value] of Object.entries(p.env)) {
      const ev = encrypt(value);
      await prisma.envVar.create({
        data: {
          projectId: project.id,
          key,
          valueCiphertext: ev.ciphertext,
          valueIv: ev.iv,
          valueAuthTag: ev.authTag,
          valueKeyVersion: ev.keyVersion,
        },
      });
    }

    for (let i = 0; i < p.builds.length; i++) {
      const b: SeedBuild = p.builds[i]!;
      const terminal = b.status === 'READY' || b.status === 'FAILED';
      const createdAt = new Date(Date.now() - b.agoMs);
      const startedAt = b.started || terminal ? createdAt : null;
      const finishedAt = terminal ? new Date(createdAt.getTime() + (b.durationMs ?? 0)) : null;

      const build = await prisma.build.create({
        data: {
          projectId: project.id,
          commitSha: fullSha(b.sha),
          commitMessage: b.msg,
          commitAuthor: user.githubLogin,
          branch: 'main',
          status: b.status,
          isDemo: true,
          imageTag: b.status === 'READY' ? `prodstack.azurecr.io/demo-${p.slug}:${b.sha}` : null,
          createdAt,
          startedAt,
          finishedAt,
          durationMs: terminal ? (b.durationMs ?? null) : null,
          errorMessage: b.err ?? null,
          // Historical seeded builds are terminal, so the worker ignores them
          // regardless. We still pre-claim (the demo invariant) for consistency.
          claimedAt: b.started || terminal ? createdAt : new Date(),
          claimedBy: DEMO_CLAIMED_BY,
          attempts: b.started || terminal ? 1 : 0,
        },
      });

      // Attach sample log lines to the newest build so BuildLogs has content.
      if (i === 0) {
        await prisma.logLine.createMany({
          data: SEED_LOG.map((l, idx) => ({
            buildId: build.id,
            seq: idx + 1,
            level: l.level,
            message: l.message,
            ts: new Date(createdAt.getTime() + idx * 1500),
          })),
        });
      }

      if (b.deploy) {
        await prisma.deployment.create({
          data: {
            projectId: project.id,
            buildId: build.id,
            revisionName: `${project.containerAppName}--${b.sha}`,
            active: true,
            createdAt: new Date(createdAt.getTime() + (b.durationMs ?? 0) + 2000),
          },
        });
      }
    }
  }
}

/**
 * DB-only project create for a demo session (no Azure, no GitHub, no webhook).
 * Mirrors the REAL create exactly: it does NOT start a build. Like a real
 * project, the first build is kicked explicitly via "Trigger build" (the
 * `/rebuild` demo branch → `startDemoBuild`) — a demo visitor can't `git push`,
 * so the project overview is where they land and trigger the deploy from. This
 * keeps the demo faithful to prod and avoids an auto-started build the visitor
 * never asked for. The repo is fake; the slug is deduped among the demo user's
 * existing live projects. Returns the new project id; the route re-fetches +
 * reshapes for the HTTP response.
 */
export async function createDemoProject(
  user: { id: string; githubLogin: string },
  input: CreateDemoProjectInput,
): Promise<{ projectId: string }> {
  await assertDemoUser(user.id);

  const branch = input.branch ?? 'main';

  // Re-derive the slug INSIDE the retry so a P2002 on the per-user partial unique
  // index (`project_user_slug_live`) — from two rapid demo creates racing the
  // dedup read — re-rolls a fresh slug. Mirrors `createWithSlugRetry` in
  // projects.ts (which the real create path uses).
  const project = await retryOnSlugCollision(async () => {
    const live = await prisma.project.findMany({
      where: { userId: user.id, deletedAt: null },
      select: { slug: true },
    });
    // Per-session project cap (DoS / DB-exhaustion). Count EVERY project this
    // session has ever created — INCLUDING soft-deleted tombstones — not just the
    // live ones, so a create→delete→create churn loop can't accumulate unbounded
    // tombstone Project rows (and their cascaded Build/LogLine/EnvVar children)
    // while keeping the live count under the cap. Demo delete is a soft-delete
    // (`deletedAt`, projects.ts) and the reaper only purges at session EXPIRY, so
    // a live-only count would let one visitor churn create/delete and bloat
    // Postgres at the global-limiter rate — exactly what "demo safety does NOT
    // depend on the rate limiter" must rule out. Counting all rows makes this a
    // true per-session LIFETIME ceiling: total demo Project rows ≤ DEMO_MAX_ACTIVE
    // × this, and transitively bounds every child build/log row.
    const totalEverCreated = await prisma.project.count({ where: { userId: user.id } });
    if (totalEverCreated >= env.DEMO_MAX_PROJECTS_PER_USER) {
      throw new HttpError(
        429,
        'DEMO_PROJECT_LIMIT',
        `Demo sandboxes are limited to ${env.DEMO_MAX_PROJECTS_PER_USER} projects.`,
      );
    }
    const slug = dedupedSlug(slugify(input.name), live.map((p) => p.slug));
    const wh = freshWebhookSecret();
    return prisma.project.create({
      data: {
        userId: user.id,
        name: input.name,
        slug,
        githubRepoFullName: repoFullNameFrom(input.repoUrl, user.githubLogin, slug),
        githubRepoId: syntheticRepoId(slug),
        branch,
        webhookId: null,
        webhookSecretCiphertext: wh.ciphertext,
        webhookSecretIv: wh.iv,
        webhookSecretAuthTag: wh.authTag,
        webhookSecretKeyVersion: wh.keyVersion,
        containerAppName: containerAppName(user.githubLogin, slug),
        // Set when the replay finishes (mirrors a real create — null until deploy).
        liveUrl: null,
        frameworkHint: null,
      },
    });
  });

  return { projectId: project.id };
}

/** Retry an insert once on a P2002 unique-constraint collision (slug race). */
async function retryOnSlugCollision<T>(attempt: () => Promise<T>): Promise<T> {
  try {
    return await attempt();
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return attempt();
    }
    throw err;
  }
}

/**
 * Insert a pre-claimed `isDemo` Build for an existing demo project and launch the
 * replay driver. The PRE-CLAIM (`claimedAt`/`claimedBy='demo-driver'`) is the
 * load-bearing fail-closed property (§4 layer 1): the Kaniko worker's claim query
 * only ever touches `status='QUEUED' AND "claimedAt" IS NULL`, so this row is
 * structurally invisible to it. Returns the new build id.
 */
export async function startDemoBuild(project: {
  id: string;
  branch: string;
  githubRepoFullName: string;
}): Promise<{ buildId: string }> {
  // Confirm the owning user is a demo user via the project's relation — the same
  // §4 layer-4 backstop, but starting from a project id.
  const owner = await prisma.project.findUnique({
    where: { id: project.id },
    select: { userId: true, user: { select: { isDemo: true, githubLogin: true } } },
  });
  if (owner === null || owner.user.isDemo !== true) {
    throw new Error('demoOrchestrator called for non-demo user');
  }

  // Per-project total-build cap (DoS / DB-exhaustion): bound the Build/LogLine
  // rows — and the replay timers — a single demo project can accumulate over a
  // session, independent of the per-user buildTrigger rate limiter.
  const buildsForProject = await prisma.build.count({ where: { projectId: project.id } });
  if (buildsForProject >= env.DEMO_MAX_BUILDS_PER_PROJECT) {
    throw new HttpError(
      429,
      'DEMO_BUILD_LIMIT',
      `Demo projects are limited to ${env.DEMO_MAX_BUILDS_PER_PROJECT} builds.`,
    );
  }

  // Per-session concurrency cap: bound how many replay drivers run at once across
  // ALL of this demo session's projects (each in-flight build holds replay
  // timers + polls Postgres). The /rebuild route already caps in-flight builds to
  // one PER PROJECT; this caps the session total across multiple projects.
  const inFlightForUser = await prisma.build.count({
    where: { project: { userId: owner.userId }, status: { in: DEMO_IN_FLIGHT } },
  });
  if (inFlightForUser >= env.DEMO_MAX_INFLIGHT_BUILDS_PER_USER) {
    throw new HttpError(
      429,
      'DEMO_BUILD_INFLIGHT_LIMIT',
      'Too many demo builds running at once. Wait for one to finish.',
    );
  }

  const build = await prisma.build.create({
    data: {
      projectId: project.id,
      // The fixture's captured commit; a real 7+ hex sha so any defensive
      // re-validation downstream is satisfied (demo builds never reach it).
      commitSha: fullSha('a1b2c3d'),
      commitMessage: 'demo deploy',
      commitAuthor: owner.user.githubLogin,
      branch: project.branch,
      status: 'QUEUED',
      isDemo: true,
      // Pre-claim: makes the row invisible to the worker's claimNextBuild.
      claimedAt: new Date(),
      claimedBy: DEMO_CLAIMED_BY,
    },
  });

  startDemoReplay(build.id);

  return { buildId: build.id };
}

export type DemoRolledBackDeployment = Prisma.DeploymentGetPayload<{ include: { build: true } }>;

/**
 * DB-only rollback for a demo session. Mirrors `rollbackToDeployment`
 * (services/deploy.ts) — identical ownership scoping, guards, and Deployment-row
 * bookkeeping — but performs NO `updateContainerApp`/Azure call: a demo project
 * has no real Container App, and the "image" exists only as a fake tag. The
 * rollback simply re-points the active Deployment row. This is the §4-layer-3
 * demo branch for the rollback route, which would otherwise reach real Azure
 * (CORE INVARIANT breach). Returns the new active Deployment with its build.
 */
export async function rollbackDemoDeployment(opts: {
  projectId: string;
  deploymentId: string;
  userId: string;
}): Promise<DemoRolledBackDeployment> {
  await assertDemoUser(opts.userId);

  const target = await prisma.deployment.findFirst({
    where: {
      id: opts.deploymentId,
      projectId: opts.projectId,
      project: { userId: opts.userId, deletedAt: null },
    },
    include: { build: true },
  });
  if (target === null) {
    throw new HttpError(404, 'DEPLOYMENT_NOT_FOUND');
  }
  if (target.active) {
    throw new HttpError(409, 'ALREADY_ACTIVE', 'That deployment is already live.');
  }
  if (target.build.status !== 'READY') {
    throw new HttpError(
      409,
      'BUILD_NOT_DEPLOYABLE',
      'That deployment’s build did not finish successfully, so it cannot be redeployed.',
    );
  }
  if (target.build.imageTag === null || target.build.imageTag === '') {
    throw new HttpError(
      409,
      'NO_IMAGE_FOR_BUILD',
      'That build never produced an image, so it cannot be redeployed.',
    );
  }

  const inFlight = await prisma.build.findFirst({
    where: { projectId: opts.projectId, status: { in: DEMO_IN_FLIGHT } },
    select: { id: true },
  });
  if (inFlight !== null) {
    throw new HttpError(
      409,
      'BUILD_IN_PROGRESS',
      'A build is currently running for this project. Wait for it to finish before rolling back.',
    );
  }

  try {
    return await prisma.$transaction(async (tx) => {
      await tx.deployment.updateMany({
        where: { projectId: opts.projectId, active: true },
        data: { active: false },
      });
      return tx.deployment.create({
        data: {
          projectId: opts.projectId,
          buildId: target.buildId,
          revisionName: target.revisionName,
          active: true,
          rolledBack: true,
        },
        include: { build: true },
      });
    });
  } catch (err) {
    // Same `one_active_per_project` backstop deploy.ts relies on.
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

/**
 * DB-only "stop" for a demo project. The real path (`stopContainerApp`) tells
 * Azure to stop the Container App; a demo project has none, so this just flips
 * `status` to STOPPED. This is the §4-layer-3 demo branch for the stop route,
 * which would otherwise reach real Azure (CORE INVARIANT breach). Mirrors the
 * real path's guards: ownership scoping + reject while a build is in-flight.
 */
export async function stopDemoProject(projectId: string, userId: string): Promise<void> {
  await assertDemoUser(userId);

  const project = await prisma.project.findFirst({
    where: { id: projectId, userId, deletedAt: null },
    select: { id: true, status: true },
  });
  if (project === null) {
    throw new HttpError(404, 'PROJECT_NOT_FOUND');
  }
  if (project.status === 'STOPPED') return; // idempotent no-op

  const inFlight = await prisma.build.findFirst({
    where: { projectId, status: { in: DEMO_IN_FLIGHT } },
    select: { id: true },
  });
  if (inFlight !== null) {
    throw new HttpError(
      409,
      'BUILD_IN_PROGRESS',
      'A build is currently running for this project. Wait for it to finish before stopping.',
    );
  }

  await prisma.project.update({
    where: { id: projectId },
    data: { status: 'STOPPED', stoppedAt: new Date() },
  });
}

/**
 * DB-only "resume" for a demo project — flips `status` back to ACTIVE. Unlike
 * the real path, a demo resume never auto-builds (a demo session has no real
 * git HEAD to build, and demo builds are always triggered explicitly), so there
 * is no `resumedBuild`.
 */
export async function resumeDemoProject(projectId: string, userId: string): Promise<void> {
  await assertDemoUser(userId);

  const project = await prisma.project.findFirst({
    where: { id: projectId, userId, deletedAt: null },
    select: { id: true, status: true },
  });
  if (project === null) {
    throw new HttpError(404, 'PROJECT_NOT_FOUND');
  }
  if (project.status === 'ACTIVE') return; // idempotent no-op

  await prisma.project.update({
    where: { id: projectId },
    data: { status: 'ACTIVE', stoppedAt: null },
  });
}

/**
 * Derive a plausible `owner/repo` full name for a demo project. A demo session's
 * repo is never fetched, so this is cosmetic; we reuse a parseable GitHub URL's
 * path when present, else synthesize `<login>/<slug>`. Never throws — a demo
 * create must not 400 on a malformed URL.
 */
function repoFullNameFrom(repoUrl: string, login: string, slug: string): string {
  const match = repoUrl.match(/github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  if (match) {
    return `${match[1]}/${match[2]}`;
  }
  return `${login}/${slug}`;
}
