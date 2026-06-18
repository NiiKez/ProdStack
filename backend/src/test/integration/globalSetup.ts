// Integration tier GLOBAL setup — runs EXACTLY ONCE in vitest's main process,
// before any worker spawns, and its teardown runs once after the whole suite.
//
// Why globalSetup and not setupFiles: `setupFiles` re-executes per test FILE
// (even with singleFork + isolate:false), which would start a fresh container
// and re-run `migrate deploy` for each integration file — wasteful and a
// correctness hazard (workers could end up pointed at different containers).
// globalSetup is the one hook vitest guarantees runs a single time.
//
// Handoff to workers: globalSetup runs in a DIFFERENT process from the test
// workers, and env set here does NOT propagate to them. So we persist the
// container's connection URL to a temp file; the per-worker `setupEnv.ts`
// (a `setupFiles` entry) reads it SYNCHRONOUSLY and sets
// `process.env.DATABASE_URL` before `db.ts` (which reads it at import time) is
// ever imported by a test. We deliberately avoid vitest `provide`/`inject`
// because that value is only readable asynchronously inside tests — too late
// for the import-time read of the prisma singleton.

import { execFileSync } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

const here = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(here, '..', '..', '..'); // .../backend
const repoRoot = path.resolve(backendDir, '..'); // repo root
const prismaBin = path.join(repoRoot, 'node_modules', '.bin', 'prisma');
const schemaPath = path.join(backendDir, 'prisma', 'schema.prisma');

// Sibling of this file; setupEnv.ts reads the same path.
export const DB_URL_FILE = path.join(here, '.integration-db-url');

let container: StartedPostgreSqlContainer | undefined;

export async function setup(): Promise<void> {
  container = await new PostgreSqlContainer('postgres:16')
    .withDatabase('prodstack_it')
    .withUsername('prodstack_it')
    .withPassword('prodstack_it')
    .start();

  const databaseUrl = container.getConnectionUri();

  // vitest does NOT call teardown() when setup() rejects, so anything that
  // throws after the container started (a failed `migrate deploy`, a write
  // error) would leak the running container. Stop it ourselves on failure.
  try {
    // Apply the FULL committed migration chain exactly like prod
    // (docker-entrypoint.sh -> `prisma migrate deploy`). Validates the chain
    // end-to-end and creates the hand-maintained partial unique indexes that
    // Prisma can't express — so the tests exercise the REAL constraints.
    execFileSync(prismaBin, ['migrate', 'deploy', `--schema=${schemaPath}`], {
      stdio: 'inherit',
      env: {
        ...process.env,
        // Override backend/.env's DATABASE_URL: migrate the CONTAINER, not the
        // local dev DB.
        DATABASE_URL: databaseUrl,
      },
    });

    // Hand the URL to the worker process(es).
    writeFileSync(DB_URL_FILE, databaseUrl, 'utf8');
  } catch (err) {
    await container.stop();
    container = undefined;
    throw err;
  }
}

export async function teardown(): Promise<void> {
  try {
    rmSync(DB_URL_FILE, { force: true });
  } catch {
    // ignore
  }
  await container?.stop();
}
