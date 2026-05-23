import { createApp } from './app.js';
import { prisma } from './db.js';
import { env } from './env.js';
import { logger } from './lib/logger.js';
import { startWorker, type WorkerHandle } from './services/builds/worker.js';

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

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down');
  server.close();
  if (worker) {
    await worker.stop();
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
