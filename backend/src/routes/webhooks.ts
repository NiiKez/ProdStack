import { createHmac, timingSafeEqual } from 'node:crypto';

import { Prisma } from '@prisma/client';
import { Router, type NextFunction, type Request, type Response } from 'express';

import { prisma } from '../db.js';
import { env } from '../env.js';
import { decrypt } from '../lib/crypto.js';
import { HttpError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import {
  isTrustedPullRequest,
  teardownPreviewByPr,
  upsertPreviewAndEnqueueBuild,
} from '../services/previews/previewService.js';

const router = Router();

const SIGNATURE_PREFIX = 'sha256=';
const DELIVERY_ID_RE = /^[A-Za-z0-9-]{1,128}$/;
// A commit SHA must be lowercase hex, 7–64 chars (short SHA → full SHA-1/SHA-256).
// This is a security boundary: the value flows into `git fetch`/`git checkout`
// positionals in runBuild, where a leading-dash string would be parsed as a git
// option (e.g. `--upload-pack=<cmd>` → arbitrary command execution). Reject
// anything that isn't a plain SHA before a Build row is ever created.
const COMMIT_SHA_RE = /^[0-9a-f]{7,64}$/;
// A git-ref-safe branch name (mirrors branchSchema in routes/projects.ts and the
// re-assert in runBuild). A preview's `head.ref` flows into `git clone --branch`,
// so reject leading '-' (flag injection), '..' (ref escape), whitespace/control
// chars before any preview build is created.
const BRANCH_NAME_RE = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]+$/;

interface PushPayload {
  ref?: unknown;
  repository?: { id?: unknown };
  head_commit?: {
    id?: unknown;
    message?: unknown;
    author?: { name?: unknown };
  } | null;
}

interface PullRequestPayload {
  action?: unknown;
  number?: unknown;
  pull_request?: {
    title?: unknown;
    head?: { ref?: unknown; sha?: unknown; repo?: { full_name?: unknown } | null } | null;
    base?: { repo?: { full_name?: unknown } | null } | null;
    user?: { login?: unknown } | null;
    author_association?: unknown;
  } | null;
}

/** Project fields the webhook handlers need (subset of the looked-up row). */
interface WebhookProject {
  id: string;
  previewsEnabled: boolean;
  status: string;
}

router.post('/github', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const signatureHeader = req.header('x-hub-signature-256');
    const eventHeader = req.header('x-github-event');
    const deliveryId = req.header('x-github-delivery');

    if (
      typeof signatureHeader !== 'string' ||
      !signatureHeader.startsWith(SIGNATURE_PREFIX) ||
      typeof eventHeader !== 'string' ||
      eventHeader.length === 0 ||
      typeof deliveryId !== 'string' ||
      !DELIVERY_ID_RE.test(deliveryId)
    ) {
      throw new HttpError(400, 'BAD_WEBHOOK_HEADERS');
    }

    // `express.raw` gives us the body as a Buffer; we need the exact bytes for
    // HMAC verification. If the upstream parser already turned it into an
    // object (route misconfigured), bail out loudly rather than verifying
    // against a re-serialized payload that won't match GitHub's signature.
    const rawBody = req.body;
    if (!Buffer.isBuffer(rawBody)) {
      logger.error('webhook body was not a Buffer; check middleware order in app.ts');
      throw new HttpError(500, 'INTERNAL');
    }

    let payload: PushPayload;
    try {
      payload = JSON.parse(rawBody.toString('utf8')) as PushPayload;
    } catch {
      throw new HttpError(400, 'INVALID_JSON');
    }

    const repoIdRaw = payload.repository?.id;
    if (typeof repoIdRaw !== 'number' || !Number.isInteger(repoIdRaw)) {
      throw new HttpError(400, 'INVALID_PAYLOAD');
    }

    // Scope the lookup to NON-demo projects. This is the webhook arm of the
    // demo-isolation invariant (docs/DEMO_MODE.md §4): the webhook is the only
    // mutation path not behind `requireAuth`, so it can't branch on
    // `req.user.isDemo` like every other route. A demo project has only a
    // *synthetic* repo id + secret and no real GitHub webhook configured, so a
    // delivery matching one is forged — and without this filter it would create
    // a real, claimable (`isDemo=false`, `claimedAt=null`) Build that the Kaniko
    // worker would clone + push + deploy to Azure under a demo session, bypassing
    // all four structural layers at once. `user: { isDemo: false }` makes demo
    // projects invisible here (they 404), and it also resolves a synthetic-repo-id
    // collision in favour of the real project. The runBuild backstop is the
    // belt-and-suspenders fifth layer.
    const project = await prisma.project.findFirst({
      where: { githubRepoId: repoIdRaw, deletedAt: null, user: { isDemo: false } },
    });
    if (project === null) {
      throw new HttpError(404, 'PROJECT_NOT_FOUND');
    }

    const secret = decrypt({
      ciphertext: project.webhookSecretCiphertext,
      iv: project.webhookSecretIv,
      authTag: project.webhookSecretAuthTag,
      keyVersion: project.webhookSecretKeyVersion,
    });

    const providedHex = signatureHeader.slice(SIGNATURE_PREFIX.length);
    const expectedHex = createHmac('sha256', secret).update(rawBody).digest('hex');

    // `timingSafeEqual` throws on length mismatch — pre-check so a malformed
    // signature can't crash the request.
    if (providedHex.length !== expectedHex.length) {
      logger.warn({ projectId: project.id, deliveryId }, 'webhook signature length mismatch');
      throw new HttpError(401, 'INVALID_SIGNATURE');
    }
    const providedBuf = Buffer.from(providedHex, 'hex');
    const expectedBuf = Buffer.from(expectedHex, 'hex');
    if (
      providedBuf.length !== expectedBuf.length ||
      !timingSafeEqual(providedBuf, expectedBuf)
    ) {
      logger.warn({ projectId: project.id, deliveryId }, 'webhook signature mismatch');
      throw new HttpError(401, 'INVALID_SIGNATURE');
    }

    if (eventHeader === 'ping') {
      res.status(200).json({ ok: true });
      return;
    }

    if (eventHeader === 'pull_request') {
      await handlePullRequest(rawBody, project, deliveryId, res);
      return;
    }

    if (eventHeader !== 'push') {
      res.status(204).end();
      return;
    }

    if (payload.ref !== `refs/heads/${project.branch}`) {
      res.status(204).end();
      return;
    }

    const head = payload.head_commit;
    if (
      head === null ||
      head === undefined ||
      typeof head.id !== 'string' ||
      typeof head.message !== 'string' ||
      typeof head.author?.name !== 'string'
    ) {
      throw new HttpError(400, 'INVALID_PAYLOAD');
    }
    const commitSha = head.id;
    const commitMessage = head.message;
    const commitAuthor = head.author.name;

    // Security boundary: the commit SHA reaches `git fetch`/`git checkout` as a
    // positional in the build worker. A non-hex value (e.g.
    // `--upload-pack=touch /tmp/x`) would be parsed by git as an option →
    // arbitrary command execution on the builder identity. Reject it here so no
    // Build row is ever created for a malformed SHA. Acknowledge with 202 so
    // GitHub treats the (already-signed) delivery as accepted and won't retry.
    if (!COMMIT_SHA_RE.test(commitSha)) {
      logger.warn(
        { projectId: project.id, deliveryId },
        'webhook push ignored: head_commit.id is not a valid commit sha',
      );
      res.status(202).json({ ignored: 'invalid commit sha' });
      return;
    }

    // Kill switch (degrade mode): this is a real push that would create a Build.
    // Refuse it before writing any WebhookEvent/Build rows so the platform stops
    // consuming build minutes / ACR storage while paused. GitHub treats a 503
    // with Retry-After as a transient failure and will retry the delivery later,
    // so no push is permanently lost once the switch is turned off.
    if (env.KILL_SWITCH) {
      logger.warn(
        { projectId: project.id, deliveryId, commitSha },
        'webhook push refused: kill switch active (builds paused)',
      );
      res
        .status(503)
        .set('Retry-After', '86400')
        .json({
          error: 'BUILDS_PAUSED',
          message: 'Builds are temporarily paused (usage limit).',
        });
      return;
    }

    // Stopped project: the owner has paused it (the Container App is stopped).
    // Don't queue a build for something that isn't running — acknowledge with 202
    // so GitHub treats the delivery as accepted and won't retry. No WebhookEvent
    // is recorded: there's no build to dedupe, and on resume the project rebuilds
    // the current branch head anyway, so pushes made while stopped aren't "lost"
    // — only the newest one matters, and resume picks it up.
    if (project.status === 'STOPPED') {
      logger.info(
        { projectId: project.id, deliveryId, commitSha },
        'webhook push ignored: project is stopped',
      );
      res.status(202).json({ ignored: 'project stopped' });
      return;
    }

    // Auto-deploy gate: when the project has `autoDeploy` turned off, a push is
    // acknowledged (200, so GitHub doesn't retry) but no Build is queued — the
    // user deploys manually via "Trigger build". We still record the
    // WebhookEvent for idempotency/audit so a redelivery is a clean no-op.
    if (!project.autoDeploy) {
      logger.info(
        { projectId: project.id, deliveryId, commitSha },
        'webhook push: autoDeploy disabled; recording event, skipping build',
      );
      try {
        await prisma.webhookEvent.create({ data: { id: deliveryId, projectId: project.id } });
      } catch (err) {
        if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) {
          throw err;
        }
      }
      res.status(200).json({ ok: true, autoDeploy: false });
      return;
    }

    // Insert the idempotency marker first; if a concurrent retry of the same
    // delivery races us here, exactly one transaction will create the Build.
    let buildId: string;
    try {
      buildId = await prisma.$transaction(async (tx) => {
        await tx.webhookEvent.create({
          data: { id: deliveryId, projectId: project.id },
        });
        const build = await tx.build.create({
          data: {
            projectId: project.id,
            commitSha,
            commitMessage,
            commitAuthor,
            branch: project.branch,
            status: 'QUEUED',
          },
          select: { id: true },
        });
        return build.id;
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        logger.info(
          { projectId: project.id, deliveryId },
          'duplicate webhook delivery ignored',
        );
        res.status(200).json({ ok: true, duplicate: true });
        return;
      }
      throw err;
    }

    // The Build row is already QUEUED; the build worker (in-process when
    // ENABLE_WORKER=true, otherwise the prodstack-builder Container App)
    // picks it up via the Postgres claim queue on its next poll tick.
    // No SSE "build.created" emit is needed: the M4 log-stream endpoint
    // (`/api/builds/:id/logs/stream`) discovers state by polling Postgres,
    // which works across the API/worker process boundary in prod. See
    // `routes/builds.ts` for why Postgres is the bus instead of an emitter.
    logger.info(
      { projectId: project.id, buildId, deliveryId, commitSha },
      'webhook accepted; build queued',
    );
    res.status(202).json({ buildId });
  } catch (err) {
    next(err);
  }
});

/**
 * Handle a verified `pull_request` delivery (preview / PR environments). The
 * caller has already verified the HMAC signature and resolved a non-demo
 * `project`. Gate order is deliberate:
 *   1. `closed` → tear down any existing preview (done first, and even under the
 *      kill switch / for a disabled project — teardown only ever SAVES money).
 *   2. ignore non-build actions (labeled/assigned/…).
 *   3. master switch + per-project toggle.
 *   4. TRUSTED-AUTHOR security gate (no forks; author owner/member/collaborator)
 *      — keeps the owner-gate model intact so an external Dockerfile never runs.
 *   5. stopped / kill-switch operational gates.
 *   6. SHA + branch validation (git argument-injection boundary).
 *   7. upsert the preview + enqueue a build.
 */
async function handlePullRequest(
  rawBody: Buffer,
  project: WebhookProject,
  deliveryId: string,
  res: Response,
): Promise<void> {
  let payload: PullRequestPayload;
  try {
    payload = JSON.parse(rawBody.toString('utf8')) as PullRequestPayload;
  } catch {
    throw new HttpError(400, 'INVALID_JSON');
  }

  const action = payload.action;
  const prNumber = payload.number;
  const pr = payload.pull_request;
  if (
    typeof action !== 'string' ||
    typeof prNumber !== 'number' ||
    !Number.isInteger(prNumber) ||
    prNumber <= 0 ||
    // Upper bound: PR numbers are realistically ≤7 digits, the DB column is a
    // 32-bit INTEGER, and previewContainerAppName embeds the number — reject an
    // absurd value at the boundary rather than failing on the DB insert / a
    // 32-char-name overflow deep in the worker.
    prNumber > 2_147_483_647 ||
    pr === null ||
    pr === undefined
  ) {
    throw new HttpError(400, 'INVALID_PAYLOAD');
  }

  // 1. PR closed (merged or not): tear down the preview if one exists. Before
  // every other gate and independent of the kill switch — teardown frees money.
  if (action === 'closed') {
    const tornDown = await teardownPreviewByPr(project.id, prNumber);
    logger.info({ projectId: project.id, prNumber, tornDown }, 'pull_request closed: preview teardown');
    res.status(202).json({ ok: true, prNumber, tornDown });
    return;
  }

  // 2. Only opened/reopened/synchronize spin or refresh a preview.
  if (action !== 'opened' && action !== 'reopened' && action !== 'synchronize') {
    res.status(204).end();
    return;
  }

  // 3. Master switch + per-project toggle. Acknowledge with 202 so GitHub
  // doesn't retry a deliberately-ignored delivery.
  if (!env.ENABLE_PREVIEWS) {
    res.status(202).json({ ignored: 'previews disabled' });
    return;
  }
  if (!project.previewsEnabled) {
    res.status(202).json({ ignored: 'previews disabled for project' });
    return;
  }

  // Truncate the title — it's untrusted display text stored verbatim as
  // PreviewEnvironment.title + Build.commitMessage. GitHub caps PR titles at 256
  // chars, but a forged delivery (the threat model: attacker holds the webhook
  // secret) isn't bound by that, so cap it here.
  const rawTitle = typeof pr.title === 'string' ? pr.title : '';
  const title = rawTitle.length > 0 ? rawTitle.slice(0, 256) : `PR #${prNumber}`;
  const headRef = pr.head?.ref;
  const headSha = pr.head?.sha;
  const authorLogin = pr.user?.login;
  const association = pr.author_association;
  const headRepo = pr.head?.repo?.full_name;
  const baseRepo = pr.base?.repo?.full_name;
  if (
    typeof headRef !== 'string' ||
    typeof headSha !== 'string' ||
    typeof authorLogin !== 'string' ||
    typeof association !== 'string' ||
    typeof baseRepo !== 'string'
  ) {
    throw new HttpError(400, 'INVALID_PAYLOAD');
  }
  // A PR is a fork if its head repo differs from (or is missing relative to) the
  // base repo. Forks never build a preview. GitHub repo full_names are
  // case-insensitive (`Octocat/Hello` ≡ `octocat/hello`), so case-fold both
  // sides — otherwise a legit same-repo PR whose payload casing differs would be
  // misclassified as a fork and silently rejected. (A real fork has a genuinely
  // different owner segment, so case-folding can't turn a fork into "same-repo".)
  const isFork =
    typeof headRepo !== 'string' || headRepo.toLowerCase() !== baseRepo.toLowerCase();

  // 4. Trusted-author security gate.
  if (!isTrustedPullRequest({ authorAssociation: association, isFork })) {
    logger.warn(
      { projectId: project.id, prNumber, authorLogin, association, isFork },
      'pull_request ignored: untrusted author (fork or non-collaborator)',
    );
    res.status(202).json({ ignored: 'untrusted author' });
    return;
  }

  // 5a. Stopped project — don't spin previews for a paused app.
  if (project.status === 'STOPPED') {
    res.status(202).json({ ignored: 'project stopped' });
    return;
  }

  // 5b. Kill switch — refuse NEW preview builds (503 + Retry-After lets GitHub
  // redeliver once the switch is off, so the PR isn't permanently un-previewed).
  if (env.KILL_SWITCH) {
    logger.warn(
      { projectId: project.id, prNumber },
      'pull_request preview refused: kill switch active',
    );
    res
      .status(503)
      .set('Retry-After', '86400')
      .json({ error: 'BUILDS_PAUSED', message: 'Builds are temporarily paused (usage limit).' });
    return;
  }

  // 6. Git argument-injection boundary — same as the push path.
  if (!COMMIT_SHA_RE.test(headSha)) {
    res.status(202).json({ ignored: 'invalid commit sha' });
    return;
  }
  // Length-cap mirrors runBuild.assertValidBranchName / branchSchema (≤255): the
  // push path bounds `branch` via project.branch (already through branchSchema),
  // but the PR head.ref comes straight off the wire, so cap it here too rather
  // than persisting a multi-kilobyte ref + spinning a builder only to throw deep
  // in the worker.
  if (headRef.length === 0 || headRef.length > 255 || !BRANCH_NAME_RE.test(headRef)) {
    res.status(202).json({ ignored: 'invalid branch name' });
    return;
  }

  // 7. Upsert the preview + enqueue the build (idempotent on the delivery id).
  const result = await upsertPreviewAndEnqueueBuild({
    projectId: project.id,
    deliveryId,
    pr: { prNumber, title, headRef, headSha, authorLogin, authorAssociation: association, isFork },
  });

  if (!result.ok) {
    if (result.reason === 'duplicate') {
      logger.info({ projectId: project.id, prNumber, deliveryId }, 'duplicate pull_request delivery ignored');
      res.status(200).json({ ok: true, duplicate: true });
      return;
    }
    logger.info(
      { projectId: project.id, prNumber },
      'pull_request preview skipped: per-project open-preview limit reached',
    );
    res.status(202).json({ ignored: 'preview limit reached' });
    return;
  }

  logger.info(
    { projectId: project.id, prNumber, previewId: result.previewId, buildId: result.buildId },
    'pull_request accepted; preview build queued',
  );
  res.status(202).json({ previewId: result.previewId, buildId: result.buildId });
}

export default router;
