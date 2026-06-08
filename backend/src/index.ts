import { createApp } from './app.js';
import { prisma } from './db.js';
import { env } from './env.js';
import { logger } from './lib/logger.js';
import { startWorker, type WorkerHandle } from './services/builds/worker.js';
import {
  startCleanupScheduler,
  type CleanupSchedulerHandle,
} from './services/cleanup/scheduler.js';
import { recoverDemoBuilds } from './services/demo/demoBuildDriver.js';

const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, nodeEnv: env.NODE_ENV }, 'API listening');
});

// In dev we co-locate the build worker inside the API process so a single
// `npm run dev` exercises the full webhook → queue → build → deploy loop
// without a second container. Prod runs the worker in its own Container App
// (`backend/dist/worker.js`) and leaves `ENABLE_WORKER=false` here.
let worker: WorkerHandle | null = null;
if (env.ENABLE_WORKER) {
  worker = startWorker();
}

// Cost-safeguard cleanup jobs (M6 §2.14) run in-process in the API on a daily
// node-cron schedule. Gated by ENABLE_CLEANUP_JOBS — a SEPARATE flag from
// ENABLE_WORKER, because in prod the API runs with ENABLE_WORKER=false (the
// build poll loop lives only on the dedicated prodstack-builder Container App,
// whose standalone worker.js entrypoint never starts this scheduler).
let cleanup: CleanupSchedulerHandle | null = null;
if (env.ENABLE_CLEANUP_JOBS) {
  cleanup = startCleanupScheduler();
}

// Demo-build boot recovery (docs/DEMO_MODE.md §5.2): scale-to-zero can tear down
// this replica mid-replay, leaving a demo build stuck in an in-flight status.
// Fast-forward any such build to READY so no sandbox build hangs "Building…".
// Strictly scoped to isDemo=true rows (the analogue of the worker's
// recoverOwnClaims), and only when the demo surface is enabled.
if (env.ENABLE_DEMO) {
  void recoverDemoBuilds()
    .then((n) => {
      if (n > 0) logger.info({ recovered: n }, 'fast-forwarded in-flight demo builds');
    })
    .catch((err) => logger.error({ err }, 'demo build recovery failed'));
}

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down');
  server.close();
  if (worker) {
    await worker.stop();
  }
  if (cleanup) {
    cleanup.stop();
  }
  try {
    await prisma.$disconnect();
  } catch (err) {
    logger.error({ err }, 'prisma disconnect failed');
  }
  process.exit(0);
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
