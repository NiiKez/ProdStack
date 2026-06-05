import rateLimit, { type RateLimitRequestHandler } from 'express-rate-limit';
import type { Request, Response } from 'express';

import { env } from '../env.js';

/**
 * Rate-limiting middleware (DoS / Azure-cost-amplification / DB-pool-exhaustion
 * defense). Every limiter is per-IP (express-rate-limit's default key) and
 * relies on `app.set('trust proxy', 1)` in app.ts so `req.ip` reflects the
 * real client behind Azure Container Apps' Envoy ingress rather than the proxy.
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
}): RateLimitRequestHandler {
  return rateLimit({
    windowMs: opts.windowMs,
    max: opts.max,
    standardHeaders: true,
    legacyHeaders: false,
    skip: opts.skip ?? (() => env.NODE_ENV === 'test'),
    message: { error: 'RATE_LIMITED', message: 'Too many requests, slow down.' },
  });
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
 * For expensive read paths that fan out to Azure (metrics fires ~4 Azure
 * Monitor queries; runtime logs hits Log Analytics; detect hits the GitHub API)
 * — these amplify cost/load far beyond a cheap DB read, so cap them tighter.
 */
export const expensiveLimiter: RateLimitRequestHandler = makeRateLimiter({
  windowMs: 60 * 1000, // 1 min
  max: 30,
  name: 'expensive',
});

/** Build triggers enqueue an Azure build (kaniko worker → ACR push → roll a
 *  revision), the single most expensive operation in the platform. */
export const buildTriggerLimiter: RateLimitRequestHandler = makeRateLimiter({
  windowMs: 5 * 60 * 1000, // 5 min
  max: 10,
  name: 'buildTrigger',
});

/** SSE log streams hold a long-lived connection + poll Postgres on an interval;
 *  cap how fast a client can open new ones. */
export const streamLimiter: RateLimitRequestHandler = makeRateLimiter({
  windowMs: 60 * 1000, // 1 min
  max: 30,
  name: 'stream',
});
