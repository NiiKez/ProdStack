/**
 * Demo workspace seed data — the fake "already deployed" projects a freshly
 * minted demo session lands on, so the dashboard is never empty (docs/DEMO_MODE.md
 * §6.6). Ported, near-verbatim, from the local-only `scripts/seed-dev.mjs`
 * (`PROJECTS` + `SAMPLE_LOG`) into typed, exported TS constants the demo
 * orchestrator (`seedDemoWorkspace`) consumes to insert Project / EnvVar / Build /
 * Deployment / LogLine rows for the demo user.
 *
 * Nothing here touches Azure / GitHub — it's pure data. Times are expressed as
 * "ms ago" offsets so each seed run lands realistic, recent timestamps without a
 * fixed wall-clock baked into the fixture.
 */
import type { BuildStatus, LogLevel } from '@prisma/client';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** A single seeded build within a project. `agoMs` = how long ago it ran. */
export interface SeedBuild {
  /** Short commit sha; padded to a full-length hex SHA at insert time. */
  sha: string;
  msg: string;
  status: BuildStatus;
  /** How long ago (ms) the build was created. */
  agoMs: number;
  /** Build duration (ms) for terminal builds. */
  durationMs?: number;
  /** This build produced the project's active deployment. */
  deploy?: boolean;
  /** Build is mid-flight (claimed + started, no terminal time). */
  started?: boolean;
  /** Failure message for FAILED builds. */
  err?: string;
}

/** A single seeded project: row + builds + env vars (+ derived deployments/logs). */
export interface SeedProject {
  name: string;
  slug: string;
  /** `owner/repo` style full name (synthetic — never hit by git). */
  repo: string;
  framework: string;
  /** Live URL for an already-deployed project, or null. */
  live: string | null;
  builds: SeedBuild[];
  env: Record<string, string>;
}

/**
 * The seed workspace: a Node/Express API, a Next.js marketing site, and a Python
 * data pipeline — one of each major framework the detect/build path supports, so
 * a demo browser sees variety. Mirrors `seed-dev.mjs`'s `PROJECTS`.
 */
export const SEED_PROJECTS: readonly SeedProject[] = [
  {
    name: 'api-gateway',
    slug: 'api-gateway',
    repo: 'demo-org/api-gateway',
    framework: 'Node',
    live: 'https://api-gateway.demo.prodstack.live',
    builds: [
      { sha: 'a1b2c3d', msg: 'feat: rate limiting middleware', status: 'READY', agoMs: 2 * HOUR, durationMs: 94_000, deploy: true },
      { sha: '9f8e7d6', msg: 'chore: bump deps', status: 'READY', agoMs: 1 * DAY, durationMs: 88_000 },
      { sha: 'c4d5e6f', msg: 'fix: cors origin list', status: 'READY', agoMs: 2 * DAY, durationMs: 91_000 },
    ],
    env: { NODE_ENV: 'production', LOG_LEVEL: 'info' },
  },
  {
    name: 'marketing-site',
    slug: 'marketing-site',
    repo: 'demo-org/marketing-site',
    framework: 'Next.js',
    live: 'https://marketing-site.demo.prodstack.live',
    builds: [
      { sha: 'feedf00', msg: 'feat: new pricing section', status: 'READY', agoMs: 6 * HOUR, durationMs: 132_000, deploy: true },
      { sha: '0badf00', msg: 'fix: footer links', status: 'READY', agoMs: 3 * DAY, durationMs: 128_000 },
    ],
    env: { NEXT_PUBLIC_API_URL: 'https://api-gateway.demo.prodstack.live' },
  },
  {
    name: 'data-pipeline',
    slug: 'data-pipeline',
    repo: 'demo-org/data-pipeline',
    framework: 'Python',
    live: 'https://data-pipeline.demo.prodstack.live',
    builds: [
      { sha: 'badf00d', msg: 'wip: parquet export', status: 'FAILED', agoMs: 40 * MIN, durationMs: 21_000, err: 'ModuleNotFoundError: pyarrow' },
      { sha: 'ca11ab1', msg: 'feat: nightly ingest job', status: 'READY', agoMs: 4 * DAY, durationMs: 156_000, deploy: true },
    ],
    env: { PYTHONUNBUFFERED: '1' },
  },
];

/**
 * Canned log lines attached to the newest build of each seeded project so the
 * BuildLogs viewer has content to show without a live replay. Mirrors
 * `seed-dev.mjs`'s `SAMPLE_LOG`. Levels match `classifyLine` semantics so the
 * viewer colours them like a real build.
 */
export const SEED_LOG: ReadonlyArray<{ level: LogLevel; message: string }> = [
  { level: 'STEP', message: 'cloning repository at HEAD' },
  { level: 'INFO', message: 'git: HEAD is now at the target commit' },
  { level: 'STEP', message: 'building image with Kaniko' },
  { level: 'INFO', message: 'kaniko: Building stage node:20-alpine' },
  { level: 'INFO', message: 'kaniko: RUN npm ci --omit=dev' },
  { level: 'STEP', message: 'INFO Taking snapshot of full filesystem...' },
  { level: 'SUCCESS', message: 'pushed → prodstack.azurecr.io/demo-app' },
  { level: 'STEP', message: 'rolling Container App revision' },
  { level: 'SUCCESS', message: 'deployed → live URL ready' },
];
