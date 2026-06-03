import { Router, type NextFunction, type Request, type Response } from 'express';

import { prisma } from '../db.js';
import { decrypt } from '../lib/crypto.js';
import { HttpError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { GithubReposError, listUserRepos, octokitForUser } from '../services/github.js';

const router = Router();

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

router.get('/repos', async (req: Request, res: Response, next: NextFunction) => {
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

export default router;
