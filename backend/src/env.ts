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

  // Azure. Required when AZURE_STUB=false. Credentials come from the API's
  // managed identity via DefaultAzureCredential — no SP env vars because the
  // deployment tenant blocks App Registrations (see CLAUDE.md).
  AZURE_STUB: boolFromString(true),
  AZURE_SUBSCRIPTION_ID: z.string().optional(),
  AZURE_RESOURCE_GROUP: z.string().optional(),
  AZURE_REGION: z.string().default('francecentral'),
  ACR_NAME: z.string().optional(),
  CONTAINER_APPS_ENV_ID: z.string().optional(),

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

  // Feature gates
  ENABLE_WORKER: boolFromString(false),
  KILL_SWITCH: boolFromString(false),
});

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
