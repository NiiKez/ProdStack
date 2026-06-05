import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

import { prisma } from '../db.js';
import { decrypt } from '../lib/crypto.js';
import { HttpError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { expensiveLimiter } from '../middleware/rateLimit.js';
import { requireXRequestedWith } from '../middleware/requireXRequestedWith.js';
import { detectFramework } from '../services/builds/dockerfileGen.js';
import {
  GithubDetectError,
  GithubReposError,
  listRepoSignals,
  listUserRepos,
  octokitForUser,
} from '../services/github.js';

const router = Router();

const REPO_URL_RE = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;

const detectBodySchema = z.object({
  repoUrl: z.string().min(1).max(255),
  ref: z.string().min(1).max(255).optional(),
});

/**
 * Map any failure that means "we can't reach GitHub on the user's behalf" — a
 * missing token, a decryption failure, or a GitHub auth error (401) — to a
 * clean 502 GITHUB_UNAVAILABLE. The frontend treats a non-200 here as "fall
 * back to manual URL entry", so this path must never 500-crash on an
 * expired/missing token.
 */
function githubUnavailable(message: string): HttpError {
  return new HttpError(502, 'GITHUB_UNAVAILABLE', message);
}

// --- GET /repos (the authenticated user's repos, for the repo picker) ------

router.get('/repos', expensiveLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.user;
    if (user === undefined || typeof user.id !== 'string') {
      throw new HttpError(401, 'UNAUTHENTICATED');
    }

    const userRow = await prisma.user.findUnique({ where: { id: user.id } });
    if (userRow === null) {
      throw new HttpError(401, 'UNAUTHENTICATED');
    }

    let githubToken: string;
    try {
      githubToken = decrypt({
        ciphertext: userRow.githubTokenCiphertext,
        iv: userRow.githubTokenIv,
        authTag: userRow.githubTokenAuthTag,
        keyVersion: userRow.githubTokenKeyVersion,
      });
    } catch (err) {
      // No stored token, or it failed to decrypt → can't reach GitHub.
      logger.warn({ err, userId: user.id }, 'github token decrypt failed for repo listing');
      throw githubUnavailable('Could not access your GitHub account. Reconnect GitHub.');
    }

    const octokit = octokitForUser(githubToken);
    let repos;
    try {
      repos = await listUserRepos(octokit);
    } catch (err) {
      if (err instanceof GithubReposError) {
        // 401 (and other auth-ish failures) → degrade to GITHUB_UNAVAILABLE so
        // the picker falls back to manual URL entry instead of erroring hard.
        logger.warn(
          { err, userId: user.id, status: err.status, githubMessage: err.githubMessage },
          'github repo listing failed',
        );
        throw githubUnavailable('GitHub is unavailable right now. Enter a repo URL manually.');
      }
      throw err;
    }

    res.json({ repos });
  } catch (err) {
    next(err);
  }
});

// --- POST /detect (framework preview for the New Project modal) -------------
// Inspect a repo via the GitHub API (no clone) and report what we'd build:
// the user's own Dockerfile if present, else the auto-detected framework +
// listen port, else "unknown". Best-effort — any GitHub failure (incl. the
// dev-login user's fake token) degrades to a 502 so the modal just hides the
// preview rather than blocking project creation.

router.post(
  '/detect',
  expensiveLimiter,
  requireXRequestedWith,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.user;
      if (user === undefined || typeof user.id !== 'string') {
        throw new HttpError(401, 'UNAUTHENTICATED');
      }

      const body = detectBodySchema.parse(req.body);
      const match = REPO_URL_RE.exec(body.repoUrl.trim());
      if (match === null) {
        throw new HttpError(400, 'INVALID_REPO_URL');
      }
      const owner = match[1]!;
      const repo = match[2]!;

      const userRow = await prisma.user.findUnique({ where: { id: user.id } });
      if (userRow === null) {
        throw new HttpError(401, 'UNAUTHENTICATED');
      }

      let githubToken: string;
      try {
        githubToken = decrypt({
          ciphertext: userRow.githubTokenCiphertext,
          iv: userRow.githubTokenIv,
          authTag: userRow.githubTokenAuthTag,
          keyVersion: userRow.githubTokenKeyVersion,
        });
      } catch (err) {
        logger.warn({ err, userId: user.id }, 'github token decrypt failed for detect');
        throw githubUnavailable('Could not access your GitHub account. Reconnect GitHub.');
      }

      const octokit = octokitForUser(githubToken);
      let signals;
      try {
        signals = await listRepoSignals(octokit, { owner, repo, ref: body.ref ?? 'HEAD' });
      } catch (err) {
        if (err instanceof GithubDetectError) {
          logger.warn(
            { err, userId: user.id, owner, repo, status: err.status },
            'repo signal listing failed',
          );
          throw githubUnavailable('Could not inspect that repository.');
        }
        throw err;
      }

      const hasDockerfile = signals.rootEntries.includes('Dockerfile');
      if (hasDockerfile) {
        res.json({ hasDockerfile: true, framework: null, port: null });
        return;
      }

      const detection = detectFramework(signals);
      res.json({
        hasDockerfile: false,
        framework: detection?.framework ?? null,
        port: detection?.port ?? null,
      });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
