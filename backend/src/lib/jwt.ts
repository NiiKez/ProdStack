import jwt, { type JwtPayload } from 'jsonwebtoken';

import { env } from '../env.js';

/**
 * Thin wrappers around `jsonwebtoken` used by the session-cookie auth flow.
 *
 * The session token is an HS256 JWT signed with `env.JWT_SECRET`. The only
 * claim we carry is `sub = userId`; everything else (email, githubLogin) is
 * loaded fresh from the database on each authed request so revocation works
 * by deleting the user.
 */

const ALGORITHM = 'HS256';
const EXPIRES_IN = '7d';

export interface SessionPayload {
  sub: string;
}

export class JwtError extends Error {
  override readonly name = 'JwtError';
  constructor(message: string, readonly cause?: unknown) {
    super(message);
  }
}

export function signSession(userId: string): string {
  try {
    return jwt.sign({ sub: userId }, env.JWT_SECRET, {
      algorithm: ALGORITHM,
      expiresIn: EXPIRES_IN,
    });
  } catch (err) {
    throw new JwtError('Failed to sign session token', err);
  }
}

export function verifySession(token: string): SessionPayload {
  let decoded: string | JwtPayload;
  try {
    decoded = jwt.verify(token, env.JWT_SECRET, { algorithms: [ALGORITHM] });
  } catch (err) {
    throw new JwtError('Invalid session token', err);
  }

  if (typeof decoded === 'string' || decoded === null || typeof decoded !== 'object') {
    throw new JwtError('Malformed session payload');
  }

  const sub = (decoded as JwtPayload).sub;
  if (typeof sub !== 'string' || sub.length === 0) {
    throw new JwtError('Session payload missing sub');
  }

  return { sub };
}
