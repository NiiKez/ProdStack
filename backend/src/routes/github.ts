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

// --- Canned data for demo sessions -----------------------------------------
// A demo user holds only a fake encrypted placeholder token, so the real
// `listUserRepos`/`listRepoSignals` paths would 502. Instead we serve fixed,
// plausible canned data BEFORE any decrypt/octokit call so the New-Project repo
// picker + detect preview work unchanged. CORE INVARIANT (docs/DEMO_MODE.md §3,
// §6.5): a demo session never reaches the real GitHub API.
const DEMO_REPOS = [
  {
    fullName: 'prodstack-demo/express-api',
    url: 'https://github.com/prodstack-demo/express-api',
    defaultBranch: 'main',
    private: false,
  },
  {
    fullName: 'prodstack-demo/next-storefront',
    url: 'https://github.com/prodstack-demo/next-storefront',
    defaultBranch: 'main',
    private: false,
  },
  {
    fullName: 'prodstack-demo/go-url-shortener',
    url: 'https://github.com/prodstack-demo/go-url-shortener',
    defaultBranch: 'main',
    private: true,
  },
  {
    fullName: 'prodstack-demo/fastapi-notes',
    url: 'https://github.com/prodstack-demo/fastapi-notes',
    defaultBranch: 'main',
    private: false,
  },
] as const;

/**
 * Canned framework-detect result for a demo session, keyed off the picked repo
 * name so the New-Project preview stays believable when a visitor selects the
 * Next.js / Go / FastAPI canned repo instead of always claiming "Express".
 * Shape matches the real `/detect` response exactly. (docs/DEMO_MODE.md §6.5.)
 */
function demoDetectFor(repo: string): { hasDockerfile: boolean; framework: string; port: number } {
  const name = repo.toLowerCase();
  if (name.includes('next')) return { hasDockerfile: false, framework: 'Next.js', port: 3000 };
  if (name.startsWith('go-')) return { hasDockerfile: false, framework: 'Go', port: 8080 };
  if (name.includes('fastapi')) return { hasDockerfile: false, framework: 'FastAPI', port: 8000 };
  return { hasDockerfile: false, framework: 'Express', port: 3000 };
}

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

    // Demo sessions get canned repos before any decrypt/octokit call (§6.5):
    // a demo user's placeholder token would otherwise 502.
    if (user.isDemo === true) {
      res.json({ repos: DEMO_REPOS });
      return;
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

      // Demo sessions get a canned detect result before any decrypt/octokit
      // call (§6.5): a demo user's placeholder token can't inspect a real repo.
      if (user.isDemo === true) {
        res.json(demoDetectFor(repo));
        return;
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
