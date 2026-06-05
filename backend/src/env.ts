/**
 * Strongly-typed, validated process.env access.
 *
 * Importing this module triggers Zod validation against the current
 * environment. On failure we log a structured list of issues and
 * `process.exit(1)` so the API never boots with bad config.
 *
 * Add a new variable in three places:
 *   1. `backend/.env.example` (with a friendly comment),
 *   2. the Zod schema below,
 *   3. consume `env.YOUR_VAR` at the call site.
 */
import { z } from 'zod';

// --- Helpers ---------------------------------------------------------------

/** Parse `"true"`/`"false"` (case-insensitive) into a boolean. */
const boolFromString = (defaultValue: boolean) =>
  z
    .union([z.string(), z.boolean()])
    .optional()
    .transform((raw) => {
      if (typeof raw === 'boolean') return raw;
      if (raw === undefined || raw === '') return defaultValue;
      const normalized = raw.trim().toLowerCase();
      if (normalized === 'true' || normalized === '1') return true;
      if (normalized === 'false' || normalized === '0') return false;
      // Anything else falls through to a refine() failure below.
      return raw;
    })
    .pipe(z.boolean({ invalid_type_error: 'must be "true" or "false"' }));

/** Validate that a base64 string decodes to exactly 32 bytes. */
const base64Key32 = z
  .string({ required_error: 'DATA_ENC_KEY is required (base64-encoded 32 bytes)' })
  .min(1, 'DATA_ENC_KEY is required (base64-encoded 32 bytes)')
  .refine(
    (value) => {
      try {
        return Buffer.from(value, 'base64').length === 32;
      } catch {
        return false;
      }
    },
    { message: 'must be base64 that decodes to exactly 32 bytes' },
  );

// --- Schema ----------------------------------------------------------------

const EnvSchema = z.object({
  // Server
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  WEB_ORIGIN: z.string().url(),
  PUBLIC_API_URL: z.string().url().default('http://localhost:3000'),

  // Database
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  // Auth / Crypto
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 chars'),
  COOKIE_SECRET: z.string().min(32, 'COOKIE_SECRET must be at least 32 chars'),
  COOKIE_DOMAIN: z.string().optional(),
  // Tri-state: 'true' / 'false' / unset. Cookies default to secure outside
  // `NODE_ENV=development`; an explicit value wins so staging/preview can opt
  // in without flipping NODE_ENV.
  COOKIE_SECURE: z
    .union([z.literal('true'), z.literal('false'), z.literal('')])
    .optional()
    .transform((raw) => {
      if (raw === undefined || raw === '') return undefined;
      return raw === 'true';
    }),
  DATA_ENC_KEY: base64Key32,

  // GitHub OAuth
  GITHUB_OAUTH_CLIENT_ID: z.string().min(1, 'GITHUB_OAUTH_CLIENT_ID is required'),
  GITHUB_OAUTH_CLIENT_SECRET: z.string().min(1, 'GITHUB_OAUTH_CLIENT_SECRET is required'),
  GITHUB_OAUTH_CALLBACK_URL: z.string().url(),
  // Single-user demo allow-list. When set,
  // only this numeric GitHub user id may complete sign-in; everyone else is
  // bounced with a "self-host" notice so the $100 student credit can't be
  // drained by arbitrary users deploying arbitrary Dockerfiles. Leave unset
  // (e.g. local dev / a self-hosted fork) to allow any GitHub user.
  OWNER_GITHUB_ID: z.coerce.number().int().positive().optional(),

  // Azure. Required when AZURE_STUB=false. Credentials come from the API's
  // managed identity via DefaultAzureCredential — no SP env vars because the
  // deployment tenant blocks App Registrations.
  AZURE_STUB: boolFromString(true),
  AZURE_SUBSCRIPTION_ID: z.string().optional(),
  AZURE_RESOURCE_GROUP: z.string().optional(),
  AZURE_REGION: z.string().default('francecentral'),
  ACR_NAME: z.string().optional(),
  CONTAINER_APPS_ENV_ID: z.string().optional(),
  // Log Analytics workspace "customer id" (GUID) backing the Container Apps
  // environment, used to query an app's runtime stdout/stderr from the
  // `ContainerAppConsoleLogs_CL` table. Read from the ACA env's
  // `appLogsConfiguration`. When unset (or AZURE_STUB=true), runtime-log
  // queries return a friendly "logs unavailable" instead of 500-ing.
  LOG_ANALYTICS_WORKSPACE_ID: z.string().optional(),

  // Build worker (M3). `stub` mirrors the M2.5 fake build for tests / fast
  // dev cycles; `docker` shells out to `docker run gcr.io/kaniko-project/...`
  // so a laptop doesn't need kaniko/git installed natively; `kaniko` calls
  // the in-image `/kaniko/executor` binary directly (used inside the
  // prodstack-builder Container App). ACR creds are only consulted by the
  // non-stub modes.
  BUILD_RUNNER_MODE: z.enum(['stub', 'docker', 'kaniko']).default('stub'),
  BUILD_TIMEOUT_MS: z.coerce.number().int().positive().default(10 * 60 * 1000),
  BUILD_WORK_DIR: z.string().default('/tmp/prodstack-builds'),
  ACR_USERNAME: z.string().optional(),
  ACR_PASSWORD: z.string().optional(),
  WORKER_ID: z.string().default(`worker-${process.pid}`),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2000),

  // CI/CD self-deploy (M6 "Option B"). The GitHub Actions pipeline builds +
  // pushes the image with ACR admin creds, then calls POST /api/admin/deploy
  // on the running API to roll the platform Container Apps — the API already
  // holds `Contributor` on the RG via its managed identity, so the GitHub
  // runner never needs Azure RBAC (App Registrations / OIDC are blocked in the
  // deployment tenant). The endpoint
  // is a no-op (503 DEPLOY_DISABLED) until this token is set, mirroring how
  // OWNER_GITHUB_ID gates the OAuth allow-list. Min 16 chars so a misconfigured
  // short/empty value can't accidentally enable a weak gate.
  DEPLOY_TOKEN: z.string().min(16, 'DEPLOY_TOKEN must be at least 16 chars').optional(),

  // Cost safeguards (M6 §2.14). Retention windows for the scheduled cleanup
  // jobs (image GC in ACR + build/log pruning in Postgres). Days, positive ints.
  RETENTION_DAYS_IMAGES: z.coerce.number().int().positive().default(30),
  RETENTION_DAYS_LOGS: z.coerce.number().int().positive().default(30),
  RETENTION_DAYS_BUILDS: z.coerce.number().int().positive().default(90),
  // Gates the cleanup admin endpoints (POST /api/admin/cleanup/*). Inert (503
  // CLEANUP_DISABLED) until set, exactly like DEPLOY_TOKEN gates /deploy. Min
  // 16 chars so a misconfigured short/empty value can't enable a weak gate.
  ADMIN_TOKEN: z.string().min(16, 'ADMIN_TOKEN must be at least 16 chars').optional(),

  // Feature gates
  ENABLE_WORKER: boolFromString(false),
  // Starts the in-process node-cron cleanup scheduler (image GC + build/log
  // pruning). DELIBERATELY a separate flag from ENABLE_WORKER: §2.14 originally
  // said "gated by ENABLE_WORKER=true", but the M6 owner decision runs cleanup
  // as in-process node-cron *in the API*, and in prod the API runs with
  // ENABLE_WORKER=false (only the dedicated prodstack-builder Container App runs
  // the build poll loop). Gating cleanup on ENABLE_WORKER would put it on the
  // builder, not the API — so it gets its own flag, set true only on the API.
  ENABLE_CLEANUP_JOBS: boolFromString(false),
  KILL_SWITCH: boolFromString(false),
});

// --- Cross-field safety guards ---------------------------------------------

/**
 * Fail closed on the dev-backdoor combination.
 *
 * The local-only dev-login backdoor (`routes/devAuth.ts`) mints a full session
 * with no auth and is mounted only when `NODE_ENV === 'development'`. Real
 * deployments talk to live Azure with `AZURE_STUB=false`. `NODE_ENV` defaults
 * to `'development'` when unset (see the schema above), so a deployment that
 * loses/omits `NODE_ENV` would silently "fail open" into dev mode and expose
 * the backdoor. Refuse to boot on exactly that dangerous combination — the
 * backdoor's trigger (`NODE_ENV === 'development'`) together with real Azure
 * (`AZURE_STUB === false`) — converting a silent fail-open into a loud
 * crash-loop. `NODE_ENV='test'` against real Azure is allowed: the backdoor
 * never mounts under `test`, and the suite legitimately exercises the
 * real-Azure code paths (logs/metrics/containerApps) with `AZURE_STUB=false`.
 *
 * Exported + pure (throws instead of `process.exit`) so it can be unit-tested
 * without spawning a subprocess; the module-load caller below catches the throw
 * and exits, matching the existing exit-on-misconfig style.
 */
export function assertSafeEnvCombination(e: {
  NODE_ENV: string;
  AZURE_STUB: boolean;
}): void {
  if (e.NODE_ENV === 'development' && e.AZURE_STUB === false) {
    throw new Error(
      'Unsafe env combination: NODE_ENV=development with AZURE_STUB=false (real Azure). ' +
        'Development mode mounts the unauthenticated dev-login backdoor (routes/devAuth.ts); ' +
        'it must never run against live Azure. Set NODE_ENV=production for any deployment that ' +
        'talks to real Azure, or set AZURE_STUB=true for local runs.',
    );
  }
}

// --- Parse + freeze --------------------------------------------------------

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('[env] Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    console.error(`  - ${path}: ${issue.message}`);
  }
  console.error('[env] See backend/.env.example for the full list of expected vars.');
  process.exit(1);
}

try {
  // Cross-field check against the PARSED env (not process.env) so runtime
  // mutations of process.env in tests can't retroactively trip the guard.
  assertSafeEnvCombination(parsed.data);
} catch (err) {
  console.error('[env] Invalid environment configuration:');
  console.error(`  - ${err instanceof Error ? err.message : String(err)}`);
  console.error('[env] See backend/.env.example for the full list of expected vars.');
  process.exit(1);
}

export type Env = z.infer<typeof EnvSchema>;

/** Validated, immutable environment. */
export const env: Readonly<Env> = Object.freeze(parsed.data);

/** Convenience flag — production hardening (Secure cookies, strict CSP, ...). */
export const isProd: boolean = env.NODE_ENV === 'production';

/**
 * No-op helper for call sites that want to make the validation
 * dependency explicit (`import { assertEnv } from './env.js'`).
 * Importing this module already triggers validation; calling this
 * just guarantees the import isn't tree-shaken.
 */
export function assertEnv(): void {
  // Intentionally empty — validation happens at module load.
}
