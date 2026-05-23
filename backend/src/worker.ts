/**
 * Standalone worker entrypoint — `node backend/dist/worker.js`.
 *
 * Used by the `prodstack-builder` Container App. In dev the worker runs
 * in-process inside the API (see `index.ts` + `ENABLE_WORKER`), so no one
 * needs to start two Node processes locally.
 */
import { prisma } from './db.js';
import { env } from './env.js';
import { logger } from './lib/logger.js';
import { startWorker } from './services/builds/worker.js';

logger.info({ mode: env.BUILD_RUNNER_MODE }, 'standalone worker booting');
const worker = startWorker();

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'worker shutting down');
  await worker.stop();
  try {
    await prisma.$disconnect();
  } catch (err) {
    logger.error({ err }, 'prisma disconnect failed');
  }
  process.exit(0);
}

// Single-use mode: when the poll loop self-aborts after a kaniko build,
// follow the same teardown path as a signal-initiated shutdown so ACA
// restarts the replica with a fresh filesystem.
void worker.done.then(() => {
  void shutdown('worker-loop-done');
});

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
