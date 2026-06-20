import { Router, type Request, type Response, type NextFunction } from 'express';

import { prisma } from '../db.js';
import { env } from '../env.js';
import { HttpError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { clearSessionCookie } from '../lib/cookies.js';
import { OAUTH_SCOPE_LIST } from '../lib/oauthScopes.js';
import { requireXRequestedWith } from '../middleware/requireXRequestedWith.js';
import { deleteContainerApp, pingAzure } from '../services/azure/index.js';

const router = Router();

function getUser(req: Request): {
  id: string;
  githubLogin: string;
  email: string | null;
  avatarUrl: string | null;
} {
  const user = req.user;
  if (user === undefined || typeof user.id !== 'string') {
    throw new HttpError(401, 'UNAUTHENTICATED');
  }
  return {
    id: user.id,
    githubLogin: user.githubLogin,
    email: user.email,
    avatarUrl: user.avatarUrl,
  };
}

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = getUser(req);

    // `connected` reflects whether a usable GitHub token is still on file.
    // Disconnect (POST /disconnect-github) zeroes these columns, so an
    // empty ciphertext buffer means the account is no longer a credential.
    const [tokenRow, projectsCount] = await Promise.all([
      prisma.user.findUnique({
        where: { id: user.id },
        select: { githubTokenCiphertext: true },
      }),
      prisma.project.count({ where: { userId: user.id, deletedAt: null } }),
    ]);
    const connected = (tokenRow?.githubTokenCiphertext?.length ?? 0) > 0;

    res.json({
      id: user.id,
      githubLogin: user.githubLogin,
      email: user.email,
      avatarUrl: user.avatarUrl,
      github: { connected, scopes: [...OAUTH_SCOPE_LIST] },
      azure: {
        mode: env.AZURE_STUB ? 'stub' : 'managed-identity',
        region: env.AZURE_REGION,
        subscriptionId: env.AZURE_SUBSCRIPTION_ID ?? null,
        resourceGroup: env.AZURE_RESOURCE_GROUP ?? null,
      },
      counts: { projects: projectsCount },
    });
  } catch (err) {
    next(err);
  }
});

router.post(
  '/disconnect-github',
  requireXRequestedWith,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = getUser(req);

      // Demo sessions carry a placeholder (non-GitHub) token and are reaped on
      // TTL — "disconnecting" it would just zero the demo row's token columns and
      // log the visitor out, corrupting an ephemeral sandbox to no purpose. Block
      // it like the other mutating demo paths (azure/test, DELETE) and projects.ts.
      if (req.user?.isDemo === true) {
        throw new HttpError(403, 'DEMO_NOT_SUPPORTED', 'Disconnecting GitHub is not available in the demo.');
      }

      const activeProjects = await prisma.project.count({
        where: { userId: user.id, deletedAt: null },
      });
      if (activeProjects > 0) {
        throw new HttpError(409, 'HAS_ACTIVE_PROJECTS');
      }

      // Clear the encrypted token columns so the row stops being a credential.
      // We don't try to revoke the token at GitHub here — that requires the
      // OAuth app's client credentials and is M2 polish; clearing local state
      // is what makes the API stop being able to act as the user.
      await prisma.user.update({
        where: { id: user.id },
        data: {
          githubTokenCiphertext: Buffer.alloc(0),
          githubTokenIv: Buffer.alloc(0),
          githubTokenAuthTag: Buffer.alloc(0),
          githubTokenKeyVersion: 0,
        },
      });

      clearSessionCookie(res);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);

// Connectivity probe surfaced on the Settings page. `pingAzure` never throws —
// a failed ping is a normal inline result, so we always return 200 and let the
// frontend render `ok: false` rather than treating it as an HTTP error.
router.post(
  '/azure/test',
  requireXRequestedWith,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // A demo session must be physically unable to reach Azure, so we never
      // call `pingAzure()` for it — that would be a real ARM read per visitor.
      // Return a canned success matching the route's `{ ok, mode }` shape
      // (docs/DEMO_MODE.md §14).
      if (req.user?.isDemo === true) {
        res.status(200).json({ ok: true, mode: 'demo' });
        return;
      }
      const result = await pingAzure();
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },
);

router.delete(
  '/',
  requireXRequestedWith,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = getUser(req);
      if (req.header('x-confirm') !== 'DELETE') {
        throw new HttpError(400, 'CONFIRMATION_REQUIRED');
      }

      // Capture the container-app names *before* the cascade so we can
      // best-effort delete them in Azure after the DB rows are gone. We only
      // tear down apps for projects that are still live; soft-deleted projects
      // had their app removed at delete time.
      const liveProjects = await prisma.project.findMany({
        where: { userId: user.id, deletedAt: null },
        select: { containerAppName: true },
      });

      // Log the apps we're about to orphan *before* the cascade removes their DB
      // rows. If the process dies between the delete and the teardown loop, this
      // is the only remaining record of which Container Apps to reap by hand —
      // and an unreaped app keeps burning the (capped) student credit.
      // NB: the stored OAuth token is dropped with the row but is NOT revoked at
      // GitHub here (deferred, same as POST /disconnect-github); the grant stays
      // live on GitHub's side until the user revokes it there.
      if (liveProjects.length > 0) {
        logger.info(
          { userId: user.id, containerApps: liveProjects.map((p) => p.containerAppName) },
          'deleting account — tearing down container apps',
        );
      }

      await prisma.user.delete({ where: { id: user.id } });
      clearSessionCookie(res);

      // Demo projects have no real Azure resource, so a demo account delete is
      // DB-only: the user-delete cascade above is all it needs. Skip the Azure
      // teardown loop entirely — mirrors the project-delete guard in
      // projects.ts (docs/DEMO_MODE.md §4 layer 3 / §14).
      const isDemo = req.user?.isDemo === true;

      if (!isDemo) {
        for (const project of liveProjects) {
          try {
            await deleteContainerApp(project.containerAppName);
          } catch (err) {
            logger.warn(
              { err, containerAppName: project.containerAppName },
              'deleteContainerApp failed during account delete',
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

export default router;
