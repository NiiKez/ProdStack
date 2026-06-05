import rateLimit, { ipKeyGenerator, type RateLimitRequestHandler } from 'express-rate-limit';
import type { Request, Response } from 'express';

import { env } from '../env.js';

/**
 * Rate-limiting middleware (DoS / Azure-cost-amplification / DB-pool-exhaustion
 * defense). Limiters fall into two families:
 *   - Pre-auth / app-wide (global, auth) key on the client IP (the default).
 *     They rely on `app.set('trust proxy', 1)` in app.ts so `req.ip` reflects
 *     the real client behind Azure Container Apps' Envoy ingress.
 *   - Post-auth (expensive, buildTrigger, stream) key on the authenticated
 *     user id via {@link userOrIpKey}. These routes all sit behind
 *     `requireAuth`, so `req.user` is always populated when the limiter runs.
 *     User-keying is deliberately INDEPENDENT of `trust proxy`/X-Forwarded-For:
 *     it can't be evaded by header spoofing and can't collapse every browser
 *     behind the frontend's nginx reverse proxy into one shared IP bucket
 *     (which would let one user's polling lock out another).
 *
 * NOTE: the default in-memory store is per-replica. It is correct ONLY because
 * every platform app runs `maxReplicas=1` (see CLAUDE.md). If that ever rises,
 * N replicas would each keep their own counter (effective limit ×N) — move to a
 * shared store (e.g. Redis) at that point.
 *
 * The DEFAULT `skip` returns true under `NODE_ENV=test` so the existing test
 * suites (which fire many requests at the same in-process app) are unaffected.
 * Callers (e.g. the limiter's own unit test) can override `skip` to actually
 * exercise limiting.
 */
export function makeRateLimiter(opts: {
  windowMs: number;
  max: number;
  name?: string;
  skip?: (req: Request, res: Response) => boolean;
  keyGenerator?: (req: Request, res: Response) => string;
}): RateLimitRequestHandler {
  return rateLimit({
    windowMs: opts.windowMs,
    max: opts.max,
    standardHeaders: true,
    legacyHeaders: false,
    skip: opts.skip ?? (() => env.NODE_ENV === 'test'),
    ...(opts.keyGenerator !== undefined ? { keyGenerator: opts.keyGenerator } : {}),
    message: { error: 'RATE_LIMITED', message: 'Too many requests, slow down.' },
  });
}

/**
 * Key post-auth limiters by the authenticated user id, falling back to the
 * client IP for the (in practice unreachable — these routes are behind
 * `requireAuth`) anonymous case. The IP fallback goes through
 * `ipKeyGenerator` so IPv6 addresses are normalized to a /56 subnet rather
 * than letting an attacker rotate the host portion for a fresh bucket.
 */
export function userOrIpKey(req: Request): string {
  const userId = req.user?.id;
  if (typeof userId === 'string' && userId.length > 0) return `u:${userId}`;
  return ipKeyGenerator(req.ip ?? '');
}

/** Paths the global limiter must never throttle: ACA liveness/readiness probes
 *  hit them constantly and a 429 there would mark the container unhealthy. */
function isHealthPath(req: Request): boolean {
  // `req.path` is relative to the app mount (always '/' here), so match the
  // original URL's pathname. Health is mounted at both `/healthz` and
  // `/api/health`.
  const path = req.path;
  return (
    path === '/healthz' ||
    path.startsWith('/healthz/') ||
    path === '/api/health' ||
    path.startsWith('/api/health/')
  );
}

/**
 * Global limiter mounted app-wide. Generous ceiling — it's a backstop against a
 * single client flooding the API, not a per-endpoint quota. Skips health
 * endpoints (probe traffic) and, like every limiter, the test env.
 */
export const globalLimiter: RateLimitRequestHandler = makeRateLimiter({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 300,
  name: 'global',
  skip: (req) => env.NODE_ENV === 'test' || isHealthPath(req),
});

/**
 * Pre-auth limiter for the OAuth dance (`/api/auth/github/begin` +
 * `/github/callback`). The callback fans out to GitHub (code→token exchange +
 * profile fetch) on every hit, so an unauthenticated flood there amplifies
 * outbound load / burns GitHub quota. Keyed on IP (these run before any session
 * exists). Generous enough for a real user retrying a login, tight enough to
 * blunt automated hammering — well under the app-wide 300/15m global backstop.
 */
export const authLimiter: RateLimitRequestHandler = makeRateLimiter({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 40,
  name: 'auth',
});

/**
 * For expensive read paths that fan out to Azure (metrics fires ~4 Azure
 * Monitor queries; runtime logs hits Log Analytics; detect hits the GitHub API)
 * — these amplify cost/load far beyond a cheap DB read, so cap them tighter.
 * Keyed per authenticated user (see {@link userOrIpKey}).
 */
export const expensiveLimiter: RateLimitRequestHandler = makeRateLimiter({
  windowMs: 60 * 1000, // 1 min
  max: 30,
  name: 'expensive',
  keyGenerator: userOrIpKey,
});

/** Build triggers enqueue an Azure build (kaniko worker → ACR push → roll a
 *  revision), the single most expensive operation in the platform. Keyed per
 *  authenticated user. */
export const buildTriggerLimiter: RateLimitRequestHandler = makeRateLimiter({
  windowMs: 5 * 60 * 1000, // 5 min
  max: 10,
  name: 'buildTrigger',
  keyGenerator: userOrIpKey,
});

/** SSE log streams hold a long-lived connection + poll Postgres on an interval;
 *  cap how fast a client can open new ones. Keyed per authenticated user so a
 *  browser's EventSource auto-reconnects (and multiple tabs) don't collide with
 *  other clients sharing the frontend proxy's IP. */
export const streamLimiter: RateLimitRequestHandler = makeRateLimiter({
  windowMs: 60 * 1000, // 1 min
  max: 30,
  name: 'stream',
  keyGenerator: userOrIpKey,
});
