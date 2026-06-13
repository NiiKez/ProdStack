import { timingSafeEqual } from 'node:crypto';

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
 * Constant-time check that a request provably arrived through our OWN
 * prodstack-web nginx edge, which injects the `X-ProdStack-Edge` shared-secret
 * header (`proxy_set_header`, so a client-supplied value is overwritten, not
 * forgeable). Returns true ALSO when no `EDGE_PROXY_SECRET` is configured — then
 * we fall back to trusting `req.ip` (today's behavior: dev/test and any
 * not-yet-wired deploy keep working). Returns false ONLY when a secret IS set and
 * the header is absent/wrong — i.e. a direct hit on the API's own FQDN, where the
 * X-Forwarded-For chain is attacker-controlled.
 */
function arrivedViaTrustedEdge(req: Request): boolean {
  const secret = env.EDGE_PROXY_SECRET;
  if (secret === undefined || secret === '') return true;
  const provided = req.get('x-prodstack-edge');
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  // timingSafeEqual throws on length mismatch — short-circuit first (the length
  // is not itself secret, and an attacker learns nothing from a length reject).
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * The right-most `X-Forwarded-For` entry — the address Azure Container Apps'
 * Envoy ingress appended for the TCP peer that actually opened the connection to
 * it. Envoy ALWAYS appends last, so a caller prepending fake entries cannot move
 * it: on a direct hit this is the attacker's real IP. Falls back to the socket
 * address when no XFF is present.
 */
function envoyAppendedPeer(req: Request): string {
  const xff = req.headers['x-forwarded-for'];
  const raw = Array.isArray(xff) ? xff[xff.length - 1] : xff;
  if (typeof raw === 'string' && raw.length > 0) {
    const last = raw.split(',').pop()?.trim();
    if (last !== undefined && last.length > 0) return last;
  }
  return req.socket?.remoteAddress ?? 'unknown';
}

/**
 * Spoof-resistant per-IP rate-limit key. The API is reachable by TWO ingress
 * paths with DIFFERENT real proxy-hop counts: the canonical prodstack.live path
 * (web-Envoy → nginx → api-Envoy = 3 hops, what `TRUST_PROXY_HOPS` is tuned for)
 * and a DIRECT hit on the API's own *.azurecontainerapps.io FQDN (api-Envoy =
 * 1 hop). A fixed `trust proxy = 3` over-trusts the short path, so a direct
 * caller can PREPEND fake `X-Forwarded-For` entries and thereby control `req.ip`
 * — a fresh bucket every request, defeating every per-IP limiter. We therefore
 * key on the resolved client IP (`req.ip`) ONLY when the request provably came
 * through our edge (the `X-ProdStack-Edge` secret); otherwise we key on the
 * un-spoofable Envoy-appended peer. IPv6 is normalized to a /56 via
 * `ipKeyGenerator` in both branches so an attacker can't rotate the host portion.
 */
export function ipRateLimitKey(req: Request): string {
  const ip = arrivedViaTrustedEdge(req) ? (req.ip ?? 'unknown') : envoyAppendedPeer(req);
  return ipKeyGenerator(ip);
}

/**
 * Key post-auth limiters by the authenticated user id, falling back to the
 * spoof-resistant per-IP key for the (in practice unreachable — these routes are
 * behind `requireAuth`) anonymous case. {@link ipRateLimitKey} already normalizes
 * IPv6 to a /56 and ignores a forged X-Forwarded-For on the direct API FQDN.
 */
export function userOrIpKey(req: Request): string {
  const userId = req.user?.id;
  if (typeof userId === 'string' && userId.length > 0) return `u:${userId}`;
  return ipRateLimitKey(req);
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
  keyGenerator: ipRateLimitKey,
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
  keyGenerator: ipRateLimitKey,
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
  keyGenerator: ipRateLimitKey,
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
  keyGenerator: ipRateLimitKey,
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
