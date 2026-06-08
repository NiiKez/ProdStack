import rateLimit, { ipKeyGenerator, type RateLimitRequestHandler } from 'express-rate-limit';
import type { Request, Response } from 'express';

import { env } from '../env.js';

/**
 * Rate-limiting middleware (DoS / Azure-cost-amplification / DB-pool-exhaustion
 * defense). Limiters fall into two families:
 *   - Pre-auth / app-wide (global, auth) key on the client IP (the default).
 *     They rely on `app.set('trust proxy', TRUST_PROXY_HOPS)` in app.ts so `req.ip` reflects
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
  // Match the FULL request pathname (req.originalUrl with the query stripped),
  // not req.path: req.path is relative to the middleware's mount point, so this
  // skip would silently stop matching if globalLimiter were ever remounted under
  // a prefix — 429-ing the ACA probes. originalUrl is always the un-stripped
  // target. Health is mounted at both `/healthz` and `/api/health`.
  const path = req.originalUrl.split('?')[0];
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
 * Pre-auth limiter for `GET /api/auth/demo-login` (docs/DEMO_MODE.md §6.1). Each
 * hit mints a fresh ephemeral demo `User` AND seeds a workspace (several DB
 * inserts), so an unthrottled flood is a cheap DB-amplification + capacity-cap
 * exhaustion vector. Keyed on IP (no session exists yet) — which is per-VISITOR
 * only because `trust proxy` (TRUST_PROXY_HOPS) is set to the true proxy-chain
 * length, so `req.ip` is the real client and not the shared nginx/Envoy upstream
 * that every prodstack.live request funnels through. (With too few trusted hops
 * the bucket collapses to that one upstream IP and a `max: 5` throttles ALL
 * visitors after a few total clicks — exactly the bug this guards against.) The
 * ceiling is a generous-per-visitor 20/15min: enough that a human retrying
 * "Launch demo" a few times never trips it, while still blunting scripted
 * hammering — the real capacity guard is `DEMO_MAX_ACTIVE`, not this. Like every
 * limiter it skips the test env (see {@link makeRateLimiter}).
 */
export const demoLoginLimiter: RateLimitRequestHandler = makeRateLimiter({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 20,
  name: 'demoLogin',
});

/**
 * Pre-auth limiter for the GitHub webhook receiver (`/api/webhooks/github`).
 * That endpoint is unauthenticated at the IP layer (it authenticates each
 * delivery by HMAC over the raw body) and — because HMAC needs the exact bytes
 * GitHub signed — mounts BEFORE `express.json()` and therefore BEFORE the
 * app-wide `globalLimiter`, so it would otherwise sit outside every throttle.
 * Each forged POST still costs an indexed project lookup + AES-GCM decrypt +
 * HMAC over up to 1MB before it's rejected, so an unthrottled flood is a cheap
 * DB/CPU-amplification vector. Keyed on IP (no session exists here). The ceiling
 * is deliberately generous — GitHub fans many real deliveries from a small,
 * stable set of source IPs — but far below the 300/15m global backstop, and it
 * blunts automated hammering from a single forging client. Like every limiter
 * it skips the test env (see {@link makeRateLimiter}).
 */
export const webhookLimiter: RateLimitRequestHandler = makeRateLimiter({
  windowMs: 60 * 1000, // 1 min
  max: 120,
  name: 'webhook',
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
