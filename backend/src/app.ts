import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';

import { env, isProd } from './env.js';
import { errorMiddleware } from './lib/errors.js';
import { logger } from './lib/logger.js';
import { requireAuth } from './middleware/requireAuth.js';
import activityRouter from './routes/activity.js';
import authRouter from './routes/auth.js';
import buildsRouter from './routes/builds.js';
import deploymentsRouter from './routes/deployments.js';
import healthRouter from './routes/health.js';
import meRouter from './routes/me.js';
import projectsRouter from './routes/projects.js';
import webhooksRouter from './routes/webhooks.js';

export function createApp(): Express {
  const app = express();

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
  app.use(pinoHttp({ logger }));
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
  // verification sees the exact bytes GitHub signed.
  app.use(
    '/api/webhooks',
    express.raw({ type: 'application/json', limit: '1mb' }),
    webhooksRouter,
  );

  app.use(express.json({ limit: '1mb' }));

  app.use('/healthz', healthRouter);
  app.use('/api/health', healthRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/projects', requireAuth, projectsRouter);
  app.use('/api/builds', requireAuth, buildsRouter);
  app.use('/api/deployments', requireAuth, deploymentsRouter);
  app.use('/api/activity', requireAuth, activityRouter);
  app.use('/api/account', requireAuth, meRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: 'NOT_FOUND' });
  });

  app.use(errorMiddleware);

  return app;
}
