/**
 * Platform self-deploy endpoint (M6 "Option B").
 *
 * The CI/CD pipeline (GitHub Actions) builds + pushes the new image to ACR with
 * admin credentials, then POSTs here to roll the platform Container App. The API
 * already holds `Contributor` on the resource group via its managed identity, so
 * the GitHub runner never needs Azure RBAC — App Registrations / OIDC are blocked
 * in the deployment tenant.
 *
 * Auth is a shared bearer-style token (`X-Deploy-Token`), NOT the user session —
 * the caller is a CI runner, not a browser. Mounted OUTSIDE `requireAuth` for
 * that reason. The endpoint is inert (503) until `DEPLOY_TOKEN` is configured,
 * mirroring how `OWNER_GITHUB_ID` gates the OAuth allow-list.
 *
 * Defence in depth: the token gate + a hard app allow-list (`PLATFORM_APPS`) +
 * a registry pin (image must live in our own ACR) mean the worst a leaked token
 * can do is point `prodstack-api`/`prodstack-web` at some other image we built.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

import { Router, type Request } from 'express';
import { z } from 'zod';

import { env } from '../env.js';
import { HttpError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { PLATFORM_APPS, rollPlatformApp } from '../services/azure/index.js';
import { cleanupBuilds } from '../services/cleanup/cleanupBuilds.js';
import { cleanupImages } from '../services/cleanup/cleanupImages.js';

const router = Router();

/**
 * Constant-time token compare. Both sides are SHA-256'd to a fixed 32 bytes
 * first so `timingSafeEqual` never throws on length mismatch and the
 * comparison leaks neither the token's length nor a character-by-character
 * early exit.
 */
function tokenMatches(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

const deployBodySchema = z.object({
  app: z.enum(['api', 'web']),
  image: z.string().min(1),
});

router.post('/deploy', async (req, res, next) => {
  try {
    if (!env.DEPLOY_TOKEN) {
      throw new HttpError(
        503,
        'DEPLOY_DISABLED',
        'Self-deploy is not configured (DEPLOY_TOKEN unset)',
      );
    }

    const presented = req.header('x-deploy-token');
    if (!presented || !tokenMatches(presented, env.DEPLOY_TOKEN)) {
      // Log (without the presented value) so a sustained guessing campaign is
      // observable — the 401 is otherwise silent, and the request access-log
      // line has the token header redacted (see lib/logger.ts REDACT_PATHS).
      logger.warn(
        { ip: req.ip, present: Boolean(presented) },
        'self-deploy: rejected invalid/missing deploy token',
      );
      throw new HttpError(401, 'UNAUTHORIZED', 'Invalid or missing deploy token');
    }

    const { app, image } = deployBodySchema.parse(req.body);
    const name = PLATFORM_APPS[app];

    // Pin the registry + repository + tag shape: only an image we built (in our
    // ACR, for this exact app, by tag) may be rolled. `ACR_NAME` is the registry
    // short name; the login server is `<name>.azurecr.io`. Falls back to the
    // known prod registry so the gate still holds when ACR_NAME isn't set (tests).
    //
    // A strict full-string regex, NOT a `startsWith` prefix check: the tag part
    // is constrained to the Docker tag grammar (no `/`, `@`, `:`, or whitespace)
    // so `<repo>:x@sha256:<digest>` or `<repo>:tag/../evil` can't slip a
    // different manifest past a cosmetic `:tag`. `name` comes from the allow-list
    // and `registry` from env; both are regex-escaped before interpolation.
    const registry = (env.ACR_NAME ?? 'prodstack').toLowerCase();
    const repo = `${registry}.azurecr.io/${name}`;
    const escapedRepo = repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const imageRe = new RegExp(`^${escapedRepo}:[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$`);
    if (!imageRe.test(image)) {
      throw new HttpError(400, 'INVALID_IMAGE', `image must be ${repo}:<tag> (no digest or path)`);
    }

    logger.info({ app, name, image }, 'self-deploy: rolling platform Container App');
    const ref = await rollPlatformApp({ name, image });

    // 202: the roll is kicked off but completes asynchronously inside Azure
    // (ACA shifts traffic once the new revision passes health probes). For
    // `app=api` this process is the old revision and will be torn down shortly
    // after responding — which is fine, the runner already has its answer.
    res.status(202).json({
      rolled: true,
      app,
      name,
      image,
      ...(ref.revisionName ? { revisionName: ref.revisionName } : {}),
    });
  } catch (err) {
    next(err);
  }
});

// --- Cost-safeguard cleanup endpoints (M6 §2.14) ---------------------------
//
// Manual triggers for the same jobs the in-process node-cron scheduler runs
// daily (image GC in ACR + build/log pruning in Postgres). Gated by a separate
// `X-Admin-Token` header (env.ADMIN_TOKEN), mirroring the /deploy token gate:
// inert (503 CLEANUP_DISABLED) until ADMIN_TOKEN is set, 401 on bad/missing
// token. Mounted outside requireAuth — the caller is an operator with the
// token, not a browser session.

/**
 * Shared gate for the cleanup endpoints. Throws an HttpError on a disabled /
 * unauthenticated request; returns normally when the presented token matches.
 */
function requireAdminToken(req: Request): void {
  if (!env.ADMIN_TOKEN) {
    throw new HttpError(
      503,
      'CLEANUP_DISABLED',
      'Cleanup endpoints are not configured (ADMIN_TOKEN unset)',
    );
  }
  const presented = req.header('x-admin-token');
  if (!presented || !tokenMatches(presented, env.ADMIN_TOKEN)) {
    // Log (without the presented value — the access-log header is also redacted,
    // see lib/logger.ts REDACT_PATHS) so a guessing campaign is observable.
    logger.warn(
      { ip: req.ip, present: Boolean(presented) },
      'cleanup: rejected invalid/missing admin token',
    );
    throw new HttpError(401, 'UNAUTHORIZED', 'Invalid or missing admin token');
  }
}

const cleanupImagesBodySchema = z.object({ dryRun: z.boolean().optional() });

router.post('/cleanup/images', async (req, res, next) => {
  try {
    requireAdminToken(req);
    const { dryRun } = cleanupImagesBodySchema.parse(req.body ?? {});
    logger.info({ dryRun: dryRun ?? false }, 'cleanup: image GC triggered via admin endpoint');
    const summary = await cleanupImages({ dryRun });
    res.status(200).json(summary);
  } catch (err) {
    next(err);
  }
});

router.post('/cleanup/builds', async (req, res, next) => {
  try {
    requireAdminToken(req);
    logger.info('cleanup: build/log pruning triggered via admin endpoint');
    const summary = await cleanupBuilds();
    res.status(200).json(summary);
  } catch (err) {
    next(err);
  }
});

export default router;
