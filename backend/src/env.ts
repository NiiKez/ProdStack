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
  // Number of reverse-proxy hops in front of the app, fed to Express's
  // `trust proxy`. `req.ip` — and therefore every per-IP rate limiter — is
  // derived by skipping this many right-most `X-Forwarded-For` entries, so it
  // MUST equal the real chain length or all clients collapse into a single
  // shared upstream IP and the limiters throttle everyone at once. A direct hit
  // on the ACA Envoy is 1 hop; via the prodstack-web nginx reverse proxy (the
  // custom domain prodstack.live) the chain is web-Envoy → nginx → api-Envoy =
  // 3. Default 1 keeps dev/test and direct-FQDN access correct; prod sets 3.
  // Numeric (NOT `true`, which trips express-rate-limit's permissive-trust-proxy
  // guard).
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(1),
  // Shared secret proving a request arrived through our OWN prodstack-web nginx
  // reverse proxy (the canonical prodstack.live path: web-Envoy → nginx →
  // api-Envoy = 3 hops). nginx injects it as the `X-ProdStack-Edge` request
  // header (`proxy_set_header` REPLACES any client-supplied value, so it can't be
  // forged). The per-IP rate limiters trust the resolved client IP (`req.ip`,
  // derived from the full X-Forwarded-For chain) ONLY for requests bearing the
  // matching header; every other request — notably a DIRECT hit on the API's own
  // *.azurecontainerapps.io FQDN, which is just 1 proxy hop, where a caller can
  // PREPEND fake X-Forwarded-For entries and so control `req.ip` — is keyed on
  // the un-spoofable address Azure's Envoy appended. UNSET (default) → trust
  // `req.ip` as before (today's behavior; dev/test and any not-yet-wired deploy
  // keep working). To ACTIVATE: set the SAME value on BOTH prodstack-web (so
  // nginx renders + injects it) and prodstack-api — web FIRST, then api, or all
  // prodstack.live traffic momentarily collapses onto one bucket. See
  // middleware/rateLimit.ts + docs/DEMO_MODE.md §6.1.
  EDGE_PROXY_SECRET: z.string().min(16, 'EDGE_PROXY_SECRET must be at least 16 chars').optional(),
  // Max concurrent SSE build-log streams a single authenticated user may hold
  // open at once. Each stream is a long-lived connection that polls Postgres on
  // an interval, so an unbounded fan-out is an event-loop / DB-pool exhaustion
  // vector (a demo visitor could otherwise open thousands). Generous enough for
  // the owner's several tabs; bounds a hostile session. See lib/streamRegistry.ts.
  MAX_LOG_STREAMS_PER_USER: z.coerce.number().int().positive().default(8),

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
  // Hard per-phase wall-clock cap on each `git clone`/`fetch`/`checkout`. Unlike
  // BUILD_TIMEOUT_MS (which only bounds kaniko), this bounds the git phases — a
  // git server that accepts the TCP connection then stalls (slow-loris on the
  // smart-HTTP transport, pathological pack data) would otherwise hang the
  // single-replica worker forever and wedge the whole build queue. A normal
  // clone takes seconds; 5 min is a generous ceiling for a large repo.
  GIT_TIMEOUT_MS: z.coerce.number().int().positive().default(5 * 60 * 1000),
  BUILD_WORK_DIR: z.string().default('/tmp/prodstack-builds'),
  // Registry-backed Kaniko layer cache (docs/BUILD_CACHE.md). BUILDER-ONLY:
  // only the prodstack-builder runs Kaniko. When enabled, Kaniko pushes each
  // built layer to `buildcache/<projectId>` in ACR keyed by a content hash and
  // pulls it on the next build instead of re-running `npm ci`/`pip install`.
  // The cache lives in ACR (not the builder's disk) so it survives the
  // scale-to-zero builder. Ships OFF by default → byte-identical Kaniko argv,
  // zero behaviour change, until the flag is flipped per the rollout runbook.
  BUILD_CACHE_ENABLED: boolFromString(false),
  // Kaniko `--cache-ttl`: how long Kaniko will REUSE a cached layer on read. It
  // does NOT delete blobs — cost is bounded by RETENTION_DAYS_CACHE + the image
  // GC, not this. Go-duration string (default 168h = 7d, matching the GC clock).
  // Validated as a Go duration so a typo (`7d` — Go has no day unit — or a
  // missing unit like `168`) fails loudly at boot instead of aborting every
  // build deep inside Kaniko's `--cache-ttl` parse.
  BUILD_CACHE_TTL: z
    .string()
    .regex(
      /^(\d+(?:\.\d+)?(ns|us|µs|ms|s|m|h))+$/,
      'must be a Go duration like "168h" or "1h30m"',
    )
    .default('168h'),
  ACR_USERNAME: z.string().optional(),
  ACR_PASSWORD: z.string().optional(),
  WORKER_ID: z.string().default(`worker-${process.pid}`),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2000),
  // Poison-pill guard. `claimNextBuild` bumps `Build.attempts` on every claim; a
  // build that crashes the worker process *before* `runBuild`'s catch can record
  // a terminal status (e.g. an OOM/SIGKILL while kaniko snapshots the FS in
  // memory on the 4 GiB builder) gets released back to QUEUED by boot recovery
  // and re-claimed — an unbounded loop that keeps the (billed) builder warm and
  // never drains the queue. Once `attempts` reaches this cap the build is failed
  // instead of re-claimed, so it gets a bounded number of real tries (default 3).
  BUILD_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),

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
  // Shorter GC clock for the registry build-cache repos (`buildcache/*`, see
  // docs/BUILD_CACHE.md). API-side: the cleanup cron runs in the API
  // (ENABLE_CLEANUP_JOBS), and it's the GC — NOT Kaniko's --cache-ttl — that
  // actually deletes old cache manifests and bounds ACR storage cost. Kept well
  // under RETENTION_DAYS_IMAGES so stale cache layers age out fast (default 7d).
  RETENTION_DAYS_CACHE: z.coerce.number().int().positive().default(7),
  // Gates the cleanup admin endpoints (POST /api/admin/cleanup/*). Inert (503
  // CLEANUP_DISABLED) until set, exactly like DEPLOY_TOKEN gates /deploy. Min
  // 16 chars so a misconfigured short/empty value can't enable a weak gate.
  ADMIN_TOKEN: z.string().min(16, 'ADMIN_TOKEN must be at least 16 chars').optional(),

  // Demo mode (docs/DEMO_MODE.md). Sandboxed public "Try ProdStack" sessions:
  // an ephemeral demo User per session, pre-seeded fake projects, and build
  // logs that are a *replay* of a captured real build — nothing touches Azure /
  // ACR / git / Kaniko. All optional with safe defaults; the master switch
  // (ENABLE_DEMO) defaults false so the surface is fully off (demo-login 404s)
  // unless explicitly enabled. Demo safety is INDEPENDENT of AZURE_STUB — it
  // comes from routing + pre-claimed builds, so ENABLE_DEMO=true is safe under
  // the intended prod config (NODE_ENV=production, AZURE_STUB=false).
  ENABLE_DEMO: boolFromString(false),
  // Demo session lifetime (minutes). A demo cookie/User older than this is
  // treated as unauthenticated and reaped by the hourly cleanup job.
  DEMO_TTL_MINUTES: z.coerce.number().int().positive().default(120),
  // Hard cap on concurrent (unexpired) demo users; demo-login returns 503 when
  // exceeded so a flood of sandbox sessions can't balloon the DB.
  DEMO_MAX_ACTIVE: z.coerce.number().int().positive().default(50),
  // Replay time-compression factor for the demo build driver. The captured
  // build is ~90s; 6× replays it in ~15s so a visitor sees the whole pipeline
  // without a long wait. 1× = real-time fidelity.
  DEMO_REPLAY_SPEED: z.coerce.number().positive().default(6),
  // Per-SESSION demo resource caps (DoS / DB-exhaustion defense, docs/DEMO_MODE.md
  // §6.3). DEMO_MAX_ACTIVE bounds the number of demo SESSIONS; these bound what a
  // SINGLE session can do, so one visitor can't fill Postgres or spawn unbounded
  // replay timers even if the per-IP rate limiter is evaded — i.e. demo safety
  // does NOT depend on the rate limiter. Positive ints; generous-for-a-demo
  // defaults. Total demo footprint is bounded by DEMO_MAX_ACTIVE × these.
  DEMO_MAX_PROJECTS_PER_USER: z.coerce.number().int().positive().default(10),
  DEMO_MAX_BUILDS_PER_PROJECT: z.coerce.number().int().positive().default(25),
  DEMO_MAX_INFLIGHT_BUILDS_PER_USER: z.coerce.number().int().positive().default(3),

  // Preview / PR environments (docs/PREVIEW_ENVIRONMENTS.md). An open pull
  // request from a TRUSTED author (owner/member/collaborator on the SAME repo —
  // never a fork) spins up an ephemeral per-PR Azure Container App (built
  // through the normal Kaniko pipeline, always min=0/max=1 scale-to-zero) and
  // tears it down on PR close. ENABLE_PREVIEWS is the master switch: when false
  // (default) the `pull_request` webhook is acknowledged but ignored (no preview,
  // no build) — so the feature is fully off until explicitly enabled, mirroring
  // ENABLE_DEMO. Safe under prod (AZURE_STUB=false): preview safety is the
  // trusted-author gate + per-project toggle, not the stub.
  ENABLE_PREVIEWS: boolFromString(false),
  // Sliding TTL backstop (hours) for a preview environment. Refreshed on every
  // push to the PR; the hourly reaper tears down any preview past it even if the
  // PR-closed webhook was missed, so a leaked preview can't idle forever. The
  // cost ceiling for orphaned previews.
  PREVIEW_TTL_HOURS: z.coerce.number().int().positive().default(72),
  // Hard cap on concurrent OPEN previews per project; a `pull_request` that would
  // exceed it is acknowledged but skipped (no preview created) so a burst of PRs
  // can't multiply Container Apps / builds without bound.
  PREVIEW_MAX_ACTIVE_PER_PROJECT: z.coerce.number().int().positive().default(5),

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
