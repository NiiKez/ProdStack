import { Router, type Request, type Response, type NextFunction } from 'express';

import { prisma } from '../db.js';
import { env } from '../env.js';
import { HttpError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { clearSessionCookie } from '../lib/cookies.js';
import { requireXRequestedWith } from '../middleware/requireXRequestedWith.js';
import { deleteContainerApp } from '../services/azure/index.js';

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
    const projectsCount = await prisma.project.count({
      where: { userId: user.id, deletedAt: null },
    });
    res.json({
      id: user.id,
      githubLogin: user.githubLogin,
      email: user.email,
      avatarUrl: user.avatarUrl,
      github: { connected: true },
      azure: { mode: env.AZURE_STUB ? 'stub' : 'global-sp' },
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

router.put(
  '/azure-credentials',
  requireXRequestedWith,
  (_req: Request, res: Response) => {
    res.status(200).json({ mode: 'global-sp', message: 'Managed by ProdStack' });
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

      await prisma.user.delete({ where: { id: user.id } });
      clearSessionCookie(res);

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

      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);

export default router;
