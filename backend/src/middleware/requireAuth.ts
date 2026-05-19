import type { NextFunction, Request, Response } from 'express';

import { prisma } from '../db.js';
import { SESSION_COOKIE, clearSessionCookie } from '../lib/cookies.js';
import { JwtError, verifySession } from '../lib/jwt.js';

/**
 * Authentication gate. Reads the signed `session` cookie, verifies the JWT,
 * loads the referenced user, and attaches a sanitized projection to
 * `req.user`. On any failure we return 401 and clear the cookie so the client
 * stops sending a token we will never accept.
 *
 * `req.user` shape is intentionally narrow — sensitive columns (encrypted
 * OAuth token) stay in the database; downstream handlers re-fetch when they
 * need them.
 */

export interface AuthedUser {
  id: string;
  githubLogin: string;
  email: string | null;
  avatarUrl: string | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthedUser;
    }
  }
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token = req.signedCookies?.[SESSION_COOKIE];
  if (typeof token !== 'string' || token.length === 0) {
    res.status(401).json({ error: 'UNAUTHORIZED' });
    return;
  }

  let payload: { sub: string };
  try {
    payload = verifySession(token);
  } catch (err) {
    if (!(err instanceof JwtError)) {
      // Unexpected — re-throw so the global error handler logs it.
      next(err);
      return;
    }
    clearSessionCookie(res);
    res.status(401).json({ error: 'UNAUTHORIZED' });
    return;
  }

  let user;
  try {
    user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, githubLogin: true, email: true, avatarUrl: true },
    });
  } catch (err) {
    next(err);
    return;
  }

  if (user === null) {
    clearSessionCookie(res);
    res.status(401).json({ error: 'UNAUTHORIZED' });
    return;
  }

  req.user = user;
  next();
}
