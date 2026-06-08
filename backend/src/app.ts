import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';

import { env, isProd } from './env.js';
import { errorMiddleware } from './lib/errors.js';
import { logger } from './lib/logger.js';
import { globalLimiter, webhookLimiter } from './middleware/rateLimit.js';
import { requireAuth } from './middleware/requireAuth.js';
import { requireXRequestedWith } from './middleware/requireXRequestedWith.js';
import activityRouter from './routes/activity.js';
import adminRouter from './routes/admin.js';
import authRouter from './routes/auth.js';
import buildsRouter from './routes/builds.js';
import demoAuthRouter from './routes/demoAuth.js';
import deploymentsRouter from './routes/deployments.js';
import githubRouter from './routes/github.js';
import healthRouter from './routes/health.js';
import meRouter from './routes/me.js';
import projectsRouter from './routes/projects.js';
import webhooksRouter from './routes/webhooks.js';

export function createApp(): Express {
  const app = express();

  // Behind Azure Container Apps' Envoy ingress — and, on the prodstack.live
  // custom-domain path, ALSO the prodstack-web nginx reverse proxy plus its own
  // Envoy — the real client IP is carried in `X-Forwarded-For`. `trust proxy`
  // must equal the number of proxy hops in front of this app so `req.ip` (and
  // every per-IP rate limiter) resolves to the actual client rather than a
  // shared infrastructure IP that every visitor funnels through. It's env-driven
  // (TRUST_PROXY_HOPS, default 1 for dev/test/direct-FQDN; prod sets 3 for the
  // web-Envoy → nginx → api-Envoy chain). Numeric — NOT `true`, which trips
  // express-rate-limit's permissive-trust-proxy guard.
  app.set('trust proxy', env.TRUST_PROXY_HOPS);

  app.use(
    helmet({
      // CSP off in dev to avoid Vite HMR / inline-script noise. In prod we set a
      // conservative policy: API only ever serves JSON, so block everything else.
      contentSecurityPolicy: isProd
        ? {
            useDefaults: false,
            directives: {
              'default-src': ["'none'"],
              'frame-ancestors': ["'none'"],
              'base-uri': ["'none'"],
              'form-action': ["'none'"],
            },
          }
        : false,
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );
  // Surface the resolved client IP (post-`trust proxy`) and the raw
  // X-Forwarded-For chain on every request log. `req.ip` is exactly what the
  // per-IP rate limiters key on, so logging it alongside the raw chain makes a
  // proxy-hop misconfiguration — e.g. all visitors collapsing into one shared
  // upstream IP behind the nginx reverse proxy — diagnosable from the logs
  // instead of inferred from a wave of 429s. See TRUST_PROXY_HOPS in env.ts.
  app.use(
    pinoHttp({
      logger,
      customProps: (req) => ({ clientIp: req.ip, xff: req.headers['x-forwarded-for'] }),
    }),
  );
  app.use(
    cors({
      origin: env.WEB_ORIGIN,
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'X-Requested-With', 'X-Confirm', 'Last-Event-ID'],
      maxAge: 600,
    }),
  );
  app.use(cookieParser(env.COOKIE_SECRET));

  // GitHub webhook receiver must mount before `express.json()` so HMAC
  // verification sees the exact bytes GitHub signed — which also puts it ahead
  // of the app-wide `globalLimiter`. A dedicated per-IP `webhookLimiter` mounts
  // ON this sub-path so an unauthenticated flood of forged deliveries can't burn
  // an indexed lookup + AES-GCM decrypt + HMAC-over-1MB unthrottled. Note: no
  // CSRF (`requireXRequestedWith`) guard here — webhooks are HMAC-authenticated
  // and GitHub never sends `X-Requested-With`.
  app.use(
    '/api/webhooks',
    webhookLimiter,
    express.raw({ type: 'application/json', limit: '1mb' }),
    webhooksRouter,
  );

  app.use(express.json({ limit: '1mb' }));

  // Global per-IP rate limit — a backstop against a single client flooding the
  // API. Mounted after body/cookie parsing and before the route handlers. It
  // skips the health endpoints internally (ACA probes hammer them; a 429 there
  // would mark the container unhealthy) and the test env.
  app.use(globalLimiter);

  app.use('/healthz', healthRouter);
  app.use('/api/health', healthRouter);

  // CSRF gate for the cookie/session-authenticated routers, applied CENTRALLY
  // (at the router-group level) rather than ad-hoc per handler — so a future
  // mutating route on any of these routers can't silently forget it. The guard
  // no-ops on safe methods (GET/HEAD/OPTIONS) and only requires
  // `X-Requested-With: XMLHttpRequest` on state-changing requests, which the SPA
  // always sends and a cross-site form/image cannot. The per-route guards still
  // in those routers are harmless redundancy.
  //
  // Deliberately NOT applied to:
  //   - `/api/webhooks` (mounted above, before express.json): HMAC-authenticated;
  //     GitHub does not send X-Requested-With.
  //   - `/api/admin` (below): authenticated by X-Deploy-Token / X-Admin-Token
  //     (not the session cookie) and called by the CI GitHub Action, which does
  //     not send X-Requested-With — guarding it would break CI self-deploy.
  app.use('/api/auth', requireXRequestedWith, authRouter);

  // Demo-login lives on the SAME `/api/auth` mount so it inherits the CSRF gate
  // (its `GET /demo-login` is exempt). Returns 404 unless ENABLE_DEMO=true, so
  // the whole demo surface is invisible when the feature is off. Coexists with
  // authRouter (different sub-paths). docs/DEMO_MODE.md §6.1.
  app.use('/api/auth', requireXRequestedWith, demoAuthRouter);

  // Machine-to-machine CI/CD self-deploy. Token-authenticated (not the user
  // session), so it mounts OUTSIDE requireAuth — see routes/admin.ts — and
  // OUTSIDE the CSRF guard (the CI runner is not a browser, sends no
  // X-Requested-With).
  app.use('/api/admin', adminRouter);

  app.use('/api/projects', requireAuth, requireXRequestedWith, projectsRouter);
  app.use('/api/github', requireAuth, requireXRequestedWith, githubRouter);
  app.use('/api/builds', requireAuth, requireXRequestedWith, buildsRouter);
  app.use('/api/deployments', requireAuth, requireXRequestedWith, deploymentsRouter);
  app.use('/api/activity', requireAuth, requireXRequestedWith, activityRouter);
  app.use('/api/account', requireAuth, requireXRequestedWith, meRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: 'NOT_FOUND' });
  });

  app.use(errorMiddleware);

  return app;
}
