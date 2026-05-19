import { PrismaClient } from '@prisma/client';

import { isProd } from './env.js';

/**
 * Prisma client singleton.
 *
 * In development we cache the client on `globalThis` so that `tsx watch`
 * hot-reloads don't spawn a new `PrismaClient` (and a new pg connection pool)
 * on every file change. In production we always create exactly one instance.
 *
 * Logging:
 *   - dev:  query + info + warn + error
 *   - prod: error only
 */
type GlobalWithPrisma = typeof globalThis & {
  __prodstackPrisma?: PrismaClient;
};

const globalForPrisma = globalThis as GlobalWithPrisma;

function createPrismaClient(): PrismaClient {
  return new PrismaClient({
    log: isProd ? ['error'] : ['query', 'info', 'warn', 'error'],
  });
}

export const prisma: PrismaClient = globalForPrisma.__prodstackPrisma ?? createPrismaClient();

if (!isProd) {
  globalForPrisma.__prodstackPrisma = prisma;
}
