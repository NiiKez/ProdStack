// Per-worker env setup for the integration tier (a `setupFiles` entry).
//
// Runs in the worker process BEFORE any test file is imported. Reads the
// container URL that `globalSetup.ts` persisted (it ran once in the main
// process) and sets `process.env.DATABASE_URL` SYNCHRONOUSLY here — this is the
// last moment before `db.ts`'s prisma singleton reads it at import time.
//
// The rest of the required env mirrors src/test/setup.ts so env.ts's Zod
// validation passes. NODE_ENV=test + AZURE_STUB=true is the boot-guard-safe
// combination.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { afterAll } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const DB_URL_FILE = path.join(here, '.integration-db-url');

const databaseUrl = readFileSync(DB_URL_FILE, 'utf8').trim();
if (!databaseUrl) {
  throw new Error('integration DATABASE_URL file is empty — globalSetup did not run');
}
process.env.DATABASE_URL = databaseUrl;

process.env.NODE_ENV ??= 'test';
process.env.WEB_ORIGIN ??= 'http://localhost:5173';
process.env.PUBLIC_API_URL ??= 'http://localhost:3000';
process.env.JWT_SECRET ??= 'test-jwt-secret-test-jwt-secret-test-jwt-secret';
process.env.COOKIE_SECRET ??= 'test-cookie-secret-test-cookie-secret-test-cookie';
process.env.DATA_ENC_KEY ??= Buffer.alloc(32, 9).toString('base64');
process.env.GITHUB_OAUTH_CLIENT_ID ??= 'test-client-id';
process.env.GITHUB_OAUTH_CLIENT_SECRET ??= 'test-client-secret';
process.env.GITHUB_OAUTH_CALLBACK_URL ??= 'http://localhost:3000/api/auth/github/callback';
process.env.AZURE_STUB ??= 'true';
process.env.LOG_LEVEL ??= 'silent';

// Close the worker's prisma connection pool after the suite so the fork exits
// cleanly (the container itself is stopped by globalSetup's teardown).
afterAll(async () => {
  try {
    const { prisma } = await import('../../db.js');
    await prisma.$disconnect();
  } catch {
    // db.ts may not have been imported if no test ran; ignore.
  }
});
