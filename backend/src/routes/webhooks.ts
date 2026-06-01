import { createHmac, timingSafeEqual } from 'node:crypto';

import { Prisma } from '@prisma/client';
import { Router, type NextFunction, type Request, type Response } from 'express';

import { prisma } from '../db.js';
import { decrypt } from '../lib/crypto.js';
import { HttpError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

const router = Router();

const SIGNATURE_PREFIX = 'sha256=';
const DELIVERY_ID_RE = /^[A-Za-z0-9-]{1,128}$/;

interface PushPayload {
  ref?: unknown;
  repository?: { id?: unknown };
  head_commit?: {
    id?: unknown;
    message?: unknown;
    author?: { name?: unknown };
  } | null;
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

    const project = await prisma.project.findFirst({
      where: { githubRepoId: repoIdRaw, deletedAt: null },
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

export default router;
