import { defineConfig } from 'vitest/config';

/**
 * Real-Postgres integration tier (testcontainers).
 *
 * Strictly OPT-IN — run with `npm run test:integration`. The default fast suite
 * (`npm run test`, `vitest.config.ts`) stays fully hermetic and excludes
 * `**\/*.integration.test.ts`; this config is the only one that boots a
 * container.
 *
 * Wiring (the load-bearing part — the prisma singleton in `src/db.ts` reads
 * `DATABASE_URL` at import time, so the URL must be set before any prod import):
 *   - `globalSetup` (`src/test/integration/globalSetup.ts`) runs EXACTLY ONCE
 *     in vitest's main process: starts ONE `postgres:16` container, runs
 *     `prisma migrate deploy`, and writes the connection URL to a temp file.
 *     Its teardown stops the container once after the whole suite.
 *   - `setupFiles` (`src/test/integration/setupEnv.ts`) runs in the worker
 *     before any test import: reads that temp file SYNCHRONOUSLY and sets
 *     `process.env.DATABASE_URL` (+ the other required env) before `db.ts` is
 *     imported. globalSetup runs in a different process, so env can't propagate
 *     directly — the file handoff is the reliable bridge.
 *   - `pool:'forks' + singleFork + isolate:false` keep all integration files in
 *     ONE worker with shared module state, so the single prisma client is
 *     reused across files (and connects to the one container).
 *
 * Coverage thresholds are NOT applied here — the 70% ratchet lives on the fast
 * suite only; this tier targets DB-level behaviors, not whole-file %.
 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.integration.test.ts'],
    globalSetup: ['src/test/integration/globalSetup.ts'],
    setupFiles: ['src/test/integration/setupEnv.ts'],
    passWithNoTests: false,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    isolate: false,
    // Run integration FILES one at a time. Without this, vitest can interleave
    // files within the single fork on the shared event loop, and one file's
    // `beforeEach` TRUNCATE wipes rows another file just inserted (FK
    // violations). Each file owns the DB exclusively for its duration.
    fileParallelism: false,
    // Container start + image pull (cold) + migrate deploy can exceed the
    // default 5s hook timeout. Generous ceilings; fast once the image is cached.
    hookTimeout: 180_000,
    testTimeout: 60_000,
  },
});
