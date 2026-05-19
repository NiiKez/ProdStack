import type { CookieOptions, Response } from 'express';

import { env } from '../env.js';

// Default: secure unless we're in development. `env.COOKIE_SECURE` (when set)
// always wins so staging/preview can flip the flag without changing NODE_ENV.
const cookieSecure =
  env.COOKIE_SECURE ?? (env.NODE_ENV !== 'development');

/**
 * Centralized cookie helpers. Every flag the auth flow cares about lives here
 * so routes/middleware never hand-roll cookie options (and so swapping
 * `SameSite=Lax` → `Strict`, adjusting `Domain`, etc. is a one-line change).
 *
 * Cookies in play:
 *   - `session`        — signed JWT, 7-day lifetime, sent on every API call
 *   - `oauth_state`    — signed CSRF token for the GitHub OAuth round-trip
 *   - `oauth_next`     — optional post-auth redirect path
 */

export const SESSION_COOKIE = 'session';
export const OAUTH_STATE_COOKIE = 'oauth_state';
export const OAUTH_NEXT_COOKIE = 'oauth_next';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const FIVE_MINUTES_MS = 5 * 60 * 1000;

function baseOptions(): CookieOptions {
  const opts: CookieOptions = {
    httpOnly: true,
    secure: cookieSecure,
    sameSite: 'lax',
    path: '/',
  };
  if (env.COOKIE_DOMAIN !== undefined && env.COOKIE_DOMAIN !== '') {
    opts.domain = env.COOKIE_DOMAIN;
  }
  return opts;
}

export function setSessionCookie(res: Response, jwtToken: string): void {
  res.cookie(SESSION_COOKIE, jwtToken, {
    ...baseOptions(),
    signed: true,
    maxAge: SEVEN_DAYS_MS,
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { ...baseOptions(), signed: true });
}

export function setOAuthStateCookie(res: Response, state: string): void {
  res.cookie(OAUTH_STATE_COOKIE, state, {
    ...baseOptions(),
    signed: true,
    maxAge: FIVE_MINUTES_MS,
  });
}

export function setOAuthNextCookie(res: Response, nextPath: string): void {
  res.cookie(OAUTH_NEXT_COOKIE, nextPath, {
    ...baseOptions(),
    signed: true,
    maxAge: FIVE_MINUTES_MS,
  });
}

export function clearOAuthCookies(res: Response): void {
  res.clearCookie(OAUTH_STATE_COOKIE, { ...baseOptions(), signed: true });
  res.clearCookie(OAUTH_NEXT_COOKIE, { ...baseOptions(), signed: true });
}
