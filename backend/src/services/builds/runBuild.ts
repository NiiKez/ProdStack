/**
 * Build runner: walks one `Build` row from claim → READY (or FAILED).
 *
 * Three responsibilities split across phases:
 *
 *  1. CLONING  — `git clone --depth 1` of the user's repo at the head SHA,
 *     using the decrypted GitHub token from the User row.
 *  2. BUILDING + PUSHING — kaniko builds the image and pushes the SHA tag
 *     plus a moving `latest-success` tag to ACR (used by M5 rollback).
 *  3. DEPLOYING — same `updateContainerApp({ image })` chokepoint M2.5
 *     already exercises, then a tx that writes the `Deployment` row and
 *     deactivates the previous one.
 *
 * `BUILD_RUNNER_MODE=stub` bypasses git+kaniko and deploys a hardcoded
 * public image instead — that's the M2.5 behavior, kept for local fast
 * cycles and the test suite (so we don't need a docker daemon to assert
 * the orchestration shell).
 *
 * Status transitions are the runner's contract with the queue: any row
 * past QUEUED must eventually reach READY/FAILED/CANCELLED, otherwise the
 * UI shows a stuck build. `try`/`finally` guarantees this even on throws.
 */
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { Prisma, type BuildStatus, type LogLevel } from '@prisma/client';

import { prisma } from '../../db.js';
import { env } from '../../env.js';
import { decrypt } from '../../lib/crypto.js';
import { logger } from '../../lib/logger.js';
import { createContainerApp, deleteContainerApp, updateContainerApp } from '../azure/index.js';
import { markPreviewFailedIfPending } from '../previews/previewService.js';
import { loadDecryptedEnvVars } from '../projectEnv.js';
import { selectBuildArgs } from './buildArgs.js';
import { BUILD_CACHE_REPO_PREFIX, runKaniko } from './kaniko.js';
import { resolveDockerfile, type ResolvedDockerfile } from './resolveDockerfile.js';

const STUB_IMAGES = [
  'mcr.microsoft.com/k8se/quickstart:latest',
  'nginxdemos/hello:latest',
] as const;

/**
 * A commit SHA must be lowercase hex, 7–64 chars (short SHA → full SHA-1 or
 * SHA-256). This is a security boundary: `commitSha` flows into `git fetch` /
 * `git checkout` positionals below, and git parses a leading-dash positional as
 * an option (e.g. `--upload-pack=<cmd>` → arbitrary command execution). The
 * webhook route validates this too, but we re-assert here so ANY caller —
 * manual trigger, seed script, future API — is protected, not just the webhook
 * path. Defense in depth.
 */
const COMMIT_SHA_RE = /^[0-9a-f]{7,64}$/;

/** Throws when `commitSha` isn't a plain hex SHA — see {@link COMMIT_SHA_RE}. */
export function assertValidCommitSha(commitSha: string): void {
  if (!COMMIT_SHA_RE.test(commitSha)) {
    throw new Error(`refusing to build: invalid commit sha`);
  }
}

/**
 * A git-ref-safe branch name. Mirrors `branchSchema` in routes/projects.ts —
 * the same security boundary, asserted again at the sink. `branch` flows into
 * `git clone --branch <branch>`: rejecting a leading '-' (flag injection),
 * '..' (ref escape), whitespace and control chars closes the argument-injection
 * class. Re-asserted here (not just at create/patch) so legacy `Project.branch`
 * rows written BEFORE branchSchema existed — and any future caller — can never
 * drive a hostile value into git. Defense in depth, same rationale as
 * {@link assertValidCommitSha}.
 */
const BRANCH_NAME_RE = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]+$/;

/** Throws when `branch` isn't git-ref-safe — see {@link BRANCH_NAME_RE}. */
export function assertValidBranchName(branch: string): void {
  if (branch.length === 0 || branch.length > 255 || !BRANCH_NAME_RE.test(branch)) {
    throw new Error(`refusing to build: invalid branch name`);
  }
}

/**
 * Build the argv for the authenticated/anonymous `git clone`. `--end-of-options`
 * guards the user-controlled positionals (`url`, `intoDir`) so git can never
 * reinterpret them as options. Pure so the arg shape is unit-testable without a
 * git process.
 *
 * Security: the auth credential is NEVER an argv element. The
 * `http.<url>.extraheader=AUTHORIZATION: Basic <base64>` config is applied via
 * the child process's `GIT_CONFIG_*` environment (see {@link authConfigEnv} /
 * {@link cloneRepo}), so the secret can't be read from `/proc/<pid>/cmdline` or
 * `ps` by any other process sharing the container. Only the non-secret
 * `credential.helper=` disable stays as an argv `-c` flag.
 */
export function cloneArgs(opts: {
  noCredHelper: string;
  branch: string;
  url: string;
  intoDir: string;
}): string[] {
  return [
    '-c',
    opts.noCredHelper,
    'clone',
    '--depth',
    '1',
    '--branch',
    opts.branch,
    '--end-of-options',
    opts.url,
    opts.intoDir,
  ];
}

/**
 * Build the argv for the single-SHA `git fetch`. `--end-of-options` immediately
 * precedes the user-controlled `commitSha` positional. As with {@link cloneArgs},
 * the auth extraheader is applied off-argv via `GIT_CONFIG_*` env, never here.
 */
export function fetchArgs(opts: {
  intoDir: string;
  noCredHelper: string;
  commitSha: string;
}): string[] {
  return [
    '-C',
    opts.intoDir,
    '-c',
    opts.noCredHelper,
    'fetch',
    '--depth',
    '1',
    'origin',
    '--end-of-options',
    opts.commitSha,
  ];
}

/**
 * Build the argv for `git checkout <sha>`. `--end-of-options` precedes the
 * user-controlled `commitSha` positional.
 */
export function checkoutArgs(opts: { intoDir: string; commitSha: string }): string[] {
  return ['-C', opts.intoDir, 'checkout', '--end-of-options', opts.commitSha];
}

const MAX_LOG_LINES_PER_BUILD = 50_000;
const LOG_LINE_MAX_BYTES = 8 * 1024;

/** How often the runner re-reads `Build.cancelRequested` to honor a cancel. */
const CANCEL_POLL_MS = 2000;

/** Grace period after an abort's SIGTERM before escalating a child to SIGKILL. */
const ABORT_KILL_GRACE_MS = 10_000;

/**
 * Statuses a build can sit in while it is still (or supposedly) being worked.
 * Used by the `finally` safety-net to detect a build the catch failed to move to
 * a terminal state. Mirrors the KEDA `builds-pending` in-flight set + QUEUED.
 */
const NON_TERMINAL_STATUSES: BuildStatus[] = [
  'QUEUED',
  'CLONING',
  'BUILDING',
  'PUSHING',
  'DEPLOYING',
];

class LogSink {
  private nextSeq = 1;
  private dropped = false;
  /**
   * Tracks fire-and-forget writes so `flush()` can wait for them before the
   * runner declares the build done. Without this, lines emitted in the last
   * few hundred ms before a kaniko failure race with `prisma.$disconnect()`
   * and silently drop — that's why a failing `RUN npm install` previously
   * surfaced only npm's final advisory line in the UI.
   */
  private readonly inflight = new Set<Promise<void>>();

  constructor(private readonly buildId: string) {}

  async write(level: LogLevel, message: string): Promise<void> {
    if (this.nextSeq > MAX_LOG_LINES_PER_BUILD) {
      if (!this.dropped) {
        this.dropped = true;
        await prisma.logLine.create({
          data: {
            buildId: this.buildId,
            seq: MAX_LOG_LINES_PER_BUILD + 1,
            level: 'WARN',
            message: `[truncated — over ${MAX_LOG_LINES_PER_BUILD} lines, suppressing the rest]`,
          },
        });
      }
      return;
    }
    const truncated =
      Buffer.byteLength(message, 'utf8') > LOG_LINE_MAX_BYTES
        ? `${message.slice(0, LOG_LINE_MAX_BYTES)}…[truncated]`
        : message;
    await prisma.logLine.create({
      data: { buildId: this.buildId, seq: this.nextSeq++, level, message: truncated },
    });
  }

  /**
   * Fire-and-forget wrapper for stream callbacks. A failed LogLine insert
   * must not crash the runner (default Node behavior on unhandled rejection
   * is process termination since v15) — just emit to the structured logger
   * and move on. The build itself keeps running. Writes are tracked so
   * `flush()` can drain them before the runner returns.
   */
  emit(level: LogLevel, message: string): void {
    const p = this.write(level, message)
      .catch((err: unknown) => {
        logger.warn({ err, buildId: this.buildId }, 'failed to persist log line');
      })
      .finally(() => {
        this.inflight.delete(p);
      });
    this.inflight.add(p);
  }

  async flush(): Promise<void> {
    // settle, not all — a single rejection must not abort the drain
    await Promise.allSettled(this.inflight);
  }
}

async function setStatus(
  buildId: string,
  status: BuildStatus,
  extra: Prisma.BuildUpdateInput = {},
): Promise<void> {
  await prisma.build.update({ where: { id: buildId }, data: { status, ...extra } });
}

/**
 * Classify a kaniko / git output line into our `LogLevel` enum so the
 * frontend can color them. Kaniko prefixes stages with `INFO`/`WARN`/
 * `ERROR` already; we just need to spot those and the implicit step
 * markers (`Building stage`, `Pushing image`).
 */
function classifyLine(line: string): LogLevel {
  if (/^ERRO\b|\bERROR\b|^error\b|^fatal\b/.test(line)) return 'ERROR';
  if (/^WARN\b|\bwarning\b/i.test(line)) return 'WARN';
  if (/^INFO\s.*\b(Building|Pushing|Resolving|Taking snapshot)\b/.test(line)) return 'STEP';
  return 'INFO';
}

interface RunBuildContext {
  buildId: string;
  workDir: string;
  repoDir: string;
  /** Sibling of `repoDir`, holds ACR creds outside the kaniko build context. */
  authDir: string;
  logs: LogSink;
}

export async function runBuild(buildId: string): Promise<void> {
  const build = await prisma.build.findUniqueOrThrow({
    where: { id: buildId },
    include: { project: { include: { user: true } } },
  });

  const workDir = path.join(env.BUILD_WORK_DIR, buildId);
  const repoDir = path.join(workDir, 'repo');
  const authDir = path.join(workDir, 'auth');
  const ctx: RunBuildContext = {
    buildId,
    workDir,
    repoDir,
    authDir,
    logs: new LogSink(buildId),
  };

  const startedAt = new Date();

  // Cooperative cancellation: the API sets `Build.cancelRequested=true` (for a
  // claimed/in-flight build it can't stop directly), and this controller's
  // signal is threaded into the git clone, kaniko, and stub phases so they
  // SIGTERM their child / bail early. A background timer polls the flag; we
  // unref it so it can't keep the (single-use) worker process alive.
  const cancel = new AbortController();
  const checkCancelled = async (): Promise<boolean> => {
    try {
      const row = await prisma.build.findUnique({
        where: { id: buildId },
        select: { cancelRequested: true },
      });
      return row?.cancelRequested === true;
    } catch {
      return false;
    }
  };
  const cancelTimer = setInterval(() => {
    void (async () => {
      if (!cancel.signal.aborted && (await checkCancelled())) cancel.abort();
    })();
  }, CANCEL_POLL_MS);
  cancelTimer.unref?.();

  try {
    // Demo-isolation backstop — the fifth, independent layer (docs/DEMO_MODE.md
    // §4). The real worker must NEVER execute a demo build: `claimNextBuild`
    // already filters `isDemo=false` and demo builds are created pre-claimed, but
    // assert here too so that a demo row reaching this function by ANY route (a
    // future caller, a pre-claim bug, a webhook for a demo project) fails closed
    // — recorded FAILED by the catch below — instead of cloning a repo, pushing
    // to ACR, and rolling a real Container App under a sandboxed session.
    if (build.isDemo) {
      throw new Error('refusing to run a demo build on the real worker (isolation backstop)');
    }

    await mkdir(workDir, { recursive: true, mode: 0o700 });
    await mkdir(authDir, { recursive: true, mode: 0o700 });

    // Immediate check: a cancel requested while the build sat in the claim
    // window must be honored without waiting a full poll interval.
    if (!cancel.signal.aborted && (await checkCancelled())) cancel.abort();

    await setStatus(buildId, 'CLONING', { startedAt });
    // Keep the in-memory row in sync with the DB write above. `build` was fetched
    // while still QUEUED (startedAt null) and is later read by deployAndRecord /
    // deployPreviewAndRecord to compute durationMs. Without this, startedAt stays
    // null there and durationMs collapses to finishedAt - finishedAt = 0.
    build.startedAt = startedAt;

    if (env.BUILD_RUNNER_MODE === 'stub') {
      await runStubBuild(build, ctx, cancel.signal);
    } else {
      await runRealBuild(build, ctx, cancel.signal);
    }
  } catch (err) {
    if (cancel.signal.aborted) {
      // A third terminal outcome alongside READY/FAILED. The user asked to
      // stop; whatever the child threw on its SIGTERM is expected, not a
      // failure — record CANCELLED, never FAILED. We still log the underlying
      // throw (the err serializer scrubs secrets) so a real teardown error
      // isn't fully masked by the cancellation.
      logger.info({ buildId, err }, 'build cancelled by user');
      await ctx.logs.write('WARN', 'build cancelled by user');
      await setStatus(buildId, 'CANCELLED', {
        finishedAt: new Date(),
        errorMessage: 'cancelled by user',
      });
      // A cancelled FIRST preview build never deployed — flip the preview
      // PENDING→FAILED too, exactly like the FAILED branch below. Without this a
      // cancelled preview is left PENDING and the UI polls it as "building"
      // forever (only the TTL reaper would ever resolve it). A cancelled REBUILD
      // of an already-ACTIVE preview leaves it ACTIVE (markPreviewFailedIfPending
      // only flips PENDING). Best-effort: must not mask the CANCELLED status.
      if (build.previewId) {
        try {
          await markPreviewFailedIfPending(build.previewId);
        } catch (markErr) {
          logger.warn({ err: markErr, buildId, previewId: build.previewId }, 'failed to mark cancelled preview FAILED');
        }
      }
    } else {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, buildId }, 'build failed');
      await ctx.logs.write('ERROR', `build failed: ${message}`);
      await setStatus(buildId, 'FAILED', {
        finishedAt: new Date(),
        errorMessage: message,
      });
      // A failed preview build that never deployed → mark the preview FAILED so
      // the UI shows it (a failed rebuild of an already-ACTIVE preview leaves the
      // prior app serving, so markPreviewFailedIfPending only flips PENDING).
      // Best-effort: a failure here must not mask the build's FAILED status.
      if (build.previewId) {
        try {
          await markPreviewFailedIfPending(build.previewId);
        } catch (markErr) {
          logger.warn({ err: markErr, buildId, previewId: build.previewId }, 'failed to mark preview FAILED');
        }
      }
    }
  } finally {
    clearInterval(cancelTimer);
    // Drain any fire-and-forget log writes before the runner returns —
    // otherwise the trailing lines (npm error output before kaniko bails,
    // git's final fatal: …, etc.) race with `prisma.$disconnect()` in
    // single-use mode and the UI shows truncated logs.
    await ctx.logs.flush();

    // Safety net: guarantee the build reached a terminal state. The catch above
    // already writes FAILED/CANCELLED — but if THAT status write itself threw
    // (a transient DB error on the wide-open shared Postgres), the row would be
    // left in an in-flight status with its claim still held. That is a real cost
    // + correctness bug: the KEDA `builds-pending` scale rule keeps counting the
    // row, so the 2 vCPU / 4 GiB builder stays billed-warm until the boot
    // stale-reaper catches it (up to 2× BUILD_TIMEOUT_MS later), and the build is
    // silently lost (the worker only ever re-claims QUEUED rows, never a stuck
    // BUILDING one). A conditional updateMany guarded on a non-terminal status is
    // a no-op on every normal path (status already READY/FAILED/CANCELLED); it
    // also clears the claim so the row can never look "claimed by a dead worker".
    try {
      const reconciled = await prisma.build.updateMany({
        where: { id: buildId, status: { in: NON_TERMINAL_STATUSES } },
        data: {
          status: 'FAILED',
          finishedAt: new Date(),
          errorMessage: 'build did not reach a terminal state (status write failed)',
          claimedAt: null,
          claimedBy: null,
        },
      });
      if (reconciled.count > 0) {
        logger.error(
          { buildId },
          'build was left in a non-terminal state after the runner finished — force-failed it',
        );
      }
    } catch (err) {
      logger.error({ err, buildId }, 'failed to reconcile build to a terminal state');
    }

    await rm(workDir, { recursive: true, force: true }).catch((err: unknown) => {
      logger.warn({ err, workDir }, 'failed to clean up build work dir');
    });
  }
}

// --- Real (kaniko) path ----------------------------------------------------

type BuildWithRelations = Prisma.BuildGetPayload<{
  include: { project: { include: { user: true } } };
}>;

async function runRealBuild(
  build: BuildWithRelations,
  ctx: RunBuildContext,
  signal: AbortSignal,
): Promise<void> {
  const token = decrypt({
    ciphertext: build.project.user.githubTokenCiphertext,
    iv: build.project.user.githubTokenIv,
    authTag: build.project.user.githubTokenAuthTag,
    keyVersion: build.project.user.githubTokenKeyVersion,
  });

  await ctx.logs.write(
    'STEP',
    `cloning ${build.project.githubRepoFullName}@${build.commitSha.slice(0, 7)}`,
  );
  await cloneRepo({
    repoFullName: build.project.githubRepoFullName,
    branch: build.branch,
    commitSha: build.commitSha,
    token,
    intoDir: ctx.repoDir,
    signal,
    onLine: (line) => {
      ctx.logs.emit(classifyLine(line), `git: ${line}`);
    },
  });

  // Build-time-public env vars (`NEXT_PUBLIC_*`, `VITE_*`, …) are inlined into
  // the client bundle by web frameworks at build time, so they must reach the
  // build as `--build-arg`s AND be declared as `ARG`s in a generated Dockerfile.
  // Everything else stays runtime-only (injected as Container App secrets at
  // deploy). We log only the names — these values are public by design.
  const buildArgs = selectBuildArgs(await loadDecryptedEnvVars(build.projectId));
  if (buildArgs.length > 0) {
    await ctx.logs.write(
      'STEP',
      `exposing ${buildArgs.length} public build var(s) to the build: ${buildArgs
        .map((a) => a.name)
        .join(', ')}`,
    );
  }

  // Pick the Dockerfile: the repo's own if present, otherwise detect the
  // framework and synthesize one (zero-Dockerfile auto-build). Throws a
  // user-facing error — surfaced as the FAILED build's message — when the repo
  // has neither a Dockerfile nor a recognizable framework.
  const resolved = await resolveDockerfile(ctx.repoDir, ctx.logs, {
    buildArgKeys: buildArgs.map((a) => a.name),
  });

  // ACR repository name = container app name (lowercase, hyphens). Image
  // path = `${acr}.azurecr.io/${appName}:${sha}` — keeps tags grouped per
  // project so retention policies / GC can act per-app.
  const acrHost = `${requireAcrName()}.azurecr.io`;
  const imageRepo = `${acrHost}/${build.project.containerAppName}`;
  const shaTag = `${imageRepo}:${build.commitSha}`;
  const latestTag = `${imageRepo}:latest-success`;

  await setStatus(ctx.buildId, 'BUILDING', { imageTag: shaTag });
  await ctx.logs.write('STEP', `building image → ${shaTag}`);

  const result = await runKaniko({
    contextDir: ctx.repoDir,
    authDir: ctx.authDir,
    dockerfile: resolved.dockerfilePath,
    destinations: [shaTag, latestTag],
    buildArgs,
    // Registry-backed layer cache (docs/BUILD_CACHE.md), opt-in via the
    // builder-only flag. Keyed on projectId — NOT previewId — so preview/PR
    // builds (same runKaniko path) warm and reuse the parent project's cache,
    // maximising hit rate. The repo lives under `buildcache/*` so the image GC
    // bounds it on a shorter clock (RETENTION_DAYS_CACHE). Off → undefined →
    // byte-identical Kaniko argv (still `--single-snapshot`).
    cache: env.BUILD_CACHE_ENABLED
      ? { repo: `${acrHost}/${BUILD_CACHE_REPO_PREFIX}${build.projectId}`, ttl: env.BUILD_CACHE_TTL }
      : undefined,
    timeoutMs: env.BUILD_TIMEOUT_MS,
    signal,
    onLine: (line, stream) => {
      ctx.logs.emit(classifyLine(line), `${stream}: ${line}`);
    },
  });

  // A cancel during the build SIGTERMs kaniko → non-zero exit. Surface it as
  // the cancellation it is (the catch in runBuild keys off signal.aborted),
  // not a spurious "kaniko exited with code N" failure.
  if (signal.aborted) {
    throw new Error('cancelled');
  }
  if (result.timedOut) {
    throw new Error(`build exceeded ${env.BUILD_TIMEOUT_MS}ms timeout`);
  }
  if (result.exitCode !== 0) {
    throw new Error(`kaniko exited with code ${result.exitCode}`);
  }

  // Kaniko pushes during build; mark PUSHING briefly so the UI's stage
  // stepper has a visible "pushed" transition between build and deploy.
  await setStatus(ctx.buildId, 'PUSHING');
  await ctx.logs.write('STEP', `pushed → ${shaTag}`);

  // Last chance to bail before the (non-abortable) Azure deploy starts. Once
  // updateContainerApp is in flight we let it finish → READY.
  if (signal.aborted) {
    throw new Error('cancelled');
  }
  await deployAndRecord(build, ctx, shaTag, resolved);
}

async function cloneRepo(opts: {
  repoFullName: string;
  branch: string;
  commitSha: string;
  token: string;
  intoDir: string;
  onLine: (line: string) => void;
  signal?: AbortSignal;
}): Promise<void> {
  // Auth via `http.<url>.extraheader` instead of embedding `x-access-token:`
  // in the URL. Two reasons:
  //   1. Embedded creds cause git to invoke its credential helper on a 401,
  //      which (no TTY) prints the confusing `fatal: could not read Username
  //      for 'https://github.com'` line even when the overall clone succeeds.
  //   2. The cleaner URL never lands in `.git/config`'s `remote.origin.url`,
  //      so a user Dockerfile that does `COPY . .` or `COPY .git …` can't
  //      bake the GitHub OAuth token into the published image.
  // `GIT_TERMINAL_PROMPT=0` makes any credential prompt fail fast (exit 1)
  // rather than waiting on a non-existent TTY — surfaces auth issues as a
  // proper non-zero exit instead of a hang or noisy fallback.
  // Defensive re-validation: even though the create/webhook boundaries reject a
  // malformed SHA or branch, assert both here so no caller (incl. a legacy
  // Project.branch row pre-dating branchSchema) can drive a hostile value into
  // the git positionals below. Throws before any git process is spawned.
  assertValidCommitSha(opts.commitSha);
  assertValidBranchName(opts.branch);

  const url = `https://github.com/${opts.repoFullName}.git`;
  // The auth header value (`AUTHORIZATION: Basic <base64(x-access-token:<token>)>`)
  // is a secret. It is applied via the git child's `GIT_CONFIG_*` environment
  // (NOT argv) so it can't be read from /proc/<pid>/cmdline or `ps` by another
  // process in the container. We keep both the raw token and this exact header
  // value in the redact set so neither can leak into a build log.
  const extraHeaderValue = authHeaderValue(opts.token);
  // The bare base64 credential blob — `basicAuth(token)` — is the actual
  // secret; redact it on its own too, in case it surfaces in a log line
  // without the `AUTHORIZATION: Basic ` prefix.
  const credentialBlob = basicAuth(opts.token);
  // `credential.helper=` disables ALL credential helpers and
  // `GIT_TERMINAL_PROMPT=0` makes any prompt attempt fail fast. Even with
  // both, git 2.x still prints one `fatal: could not read Username for
  // 'https://github.com': terminal prompts disabled` line to stderr when the
  // server challenges auth — outside of git's control. The actual clone
  // outcome is captured by the exit code; the line is cosmetic noise we
  // drop in `gitOnLine` below.
  const noCredHelper = 'credential.helper=';
  const baseGitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  // Env carrying the secret extraheader as git config (off-argv). Used for the
  // authenticated clone + the fetch; the anonymous retry and checkout omit it.
  const authGitEnv = { ...baseGitEnv, ...authConfigEnv(url, extraHeaderValue) };
  const redactSecrets = [opts.token, extraHeaderValue, credentialBlob];
  const gitOnLine = (line: string): void => {
    if (line.includes('could not read Username')) return;
    opts.onLine(line);
  };

  // Try with auth first (required for private repos). If that fails — e.g.
  // the user revoked their OAuth grant or the token expired — retry without
  // creds; public repos still clone, private ones surface the auth error.
  try {
    await spawnLogged(
      'git',
      cloneArgs({ noCredHelper, branch: opts.branch, url, intoDir: opts.intoDir }),
      {
        onLine: gitOnLine,
        redact: redactSecrets,
        env: authGitEnv,
        signal: opts.signal,
        timeoutMs: env.GIT_TIMEOUT_MS,
      },
    );
  } catch (err) {
    // Don't retry anonymously on a cancel — the user asked to stop.
    if (opts.signal?.aborted) throw err;
    // Redact before logging: this path bypasses `gitOnLine`/`spawnLogged`'s own
    // redaction, and although git's spawn error message carries no secret today,
    // routing it through `redact` keeps the credential out of the log if that
    // ever changes.
    opts.onLine(
      redact(
        `git: authenticated clone failed (${(err as Error).message}); retrying anonymously`,
        redactSecrets,
      ),
    );
    await rm(opts.intoDir, { recursive: true, force: true });
    await spawnLogged(
      'git',
      cloneArgs({ noCredHelper, branch: opts.branch, url, intoDir: opts.intoDir }),
      {
        onLine: gitOnLine,
        redact: redactSecrets,
        env: baseGitEnv,
        signal: opts.signal,
        timeoutMs: env.GIT_TIMEOUT_MS,
      },
    );
  }

  // `--depth 1` may not give us the exact commit if HEAD has advanced since
  // the webhook fired. Fetch + checkout makes the build reproducible.
  await spawnLogged(
    'git',
    fetchArgs({ intoDir: opts.intoDir, noCredHelper, commitSha: opts.commitSha }),
    {
      onLine: gitOnLine,
      redact: redactSecrets,
      env: authGitEnv,
      signal: opts.signal,
      timeoutMs: env.GIT_TIMEOUT_MS,
    },
  ).catch(() => {
    // Older git servers reject single-sha fetch; the shallow clone above is
    // good enough when HEAD hasn't moved. Continue. (A timeout here is bounded
    // by GIT_TIMEOUT_MS rather than hanging, then falls through to the shallow
    // HEAD too.)
  });
  if (opts.signal?.aborted) throw new Error('cancelled');
  await spawnLogged('git', checkoutArgs({ intoDir: opts.intoDir, commitSha: opts.commitSha }), {
    onLine: gitOnLine,
    redact: redactSecrets,
    env: baseGitEnv,
    signal: opts.signal,
    timeoutMs: env.GIT_TIMEOUT_MS,
  }).catch(() => {
    // Same fallback — if checkout fails the shallow HEAD is what we'll build.
  });
  if (opts.signal?.aborted) throw new Error('cancelled');

  // Integrity guard: confirm the working tree is actually AT the requested
  // commit. `--depth 1` clones the branch HEAD; if HEAD advanced after the
  // webhook fired, the fetch + checkout above are what pin the exact SHA — but
  // both swallow their errors (older git servers reject a single-SHA fetch).
  // Without this check a failed fetch+checkout would silently build the *wrong*
  // commit while recording it under `build.commitSha`, so the deployed image
  // would lie about its source — a subtle integrity hole. Verify HEAD and fail
  // closed on a CONFIRMED mismatch; if rev-parse can't produce a sha we don't
  // block the build (no regression over the prior "build the shallow HEAD"
  // behavior). The rev-parse spawn carries no secrets — anonymous, off-network.
  let headSha = '';
  await spawnLogged('git', ['-C', opts.intoDir, 'rev-parse', 'HEAD'], {
    onLine: (line) => {
      const t = line.trim();
      if (/^[0-9a-f]{40,64}$/.test(t)) headSha = t;
    },
    redact: redactSecrets,
    env: baseGitEnv,
    signal: opts.signal,
    timeoutMs: env.GIT_TIMEOUT_MS,
  }).catch(() => {
    // rev-parse itself failed (unusual) — don't fail the build on the integrity
    // probe; worst case is the pre-existing "build the shallow HEAD" behavior.
  });
  if (opts.signal?.aborted) throw new Error('cancelled');
  // A short requested SHA is a prefix of the full 40-char HEAD; the symmetric
  // startsWith also covers an equal/longer requested SHA. Only a definite
  // mismatch (HEAD resolved AND neither value is a prefix of the other) is fatal.
  if (
    headSha.length > 0 &&
    !headSha.startsWith(opts.commitSha) &&
    !opts.commitSha.startsWith(headSha)
  ) {
    throw new Error(
      `repository HEAD ${headSha.slice(0, 12)} does not match requested commit ` +
        `${opts.commitSha.slice(0, 12)} — the branch advanced and the exact commit could ` +
        `not be fetched from a shallow clone. Refusing to build the wrong source.`,
    );
  }
}

/** base64(`x-access-token:<token>`) — the credential blob for HTTP Basic auth. */
export function basicAuth(token: string): string {
  return Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
}

/**
 * The exact `extraheader` config VALUE git sends as the `Authorization` header.
 * This — not the raw token — is the string that actually appears in argv/config,
 * so the redactor strips it too (see {@link redact}). Reused by {@link cloneRepo}
 * and the redact set so the two can never drift.
 */
export function authHeaderValue(token: string): string {
  return `AUTHORIZATION: Basic ${basicAuth(token)}`;
}

/**
 * Apply the per-repo auth extraheader as git config via the child process's
 * ENVIRONMENT rather than argv. Git ≥2.31 reads `GIT_CONFIG_COUNT` + the
 * indexed `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>` pairs and treats them
 * exactly like `-c key=value` — but the secret stays out of `/proc/<pid>/cmdline`
 * and `ps`. node:20-alpine ships git ≥2.43, so this is supported in the worker.
 *
 * Pure + exported so the env shape is unit-testable. Only the secret header
 * moves here; the non-secret `credential.helper=` disable remains an argv `-c`.
 */
export function authConfigEnv(url: string, headerValue: string): NodeJS.ProcessEnv {
  // Build the indexed env from a pairs array and derive GIT_CONFIG_COUNT from its
  // length, so the count can never drift from the actual pairs: git reads exactly
  // GIT_CONFIG_COUNT entries, so a hand-maintained literal that lagged an added
  // pair would silently drop config (and auth would half-break with no error).
  const pairs: ReadonlyArray<readonly [string, string]> = [
    [`http.${url}.extraheader`, headerValue],
  ];
  const env: NodeJS.ProcessEnv = { GIT_CONFIG_COUNT: String(pairs.length) };
  pairs.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

/**
 * Spawn a child, stream its stdout/stderr line-by-line (redacting secrets),
 * and resolve on a 0 exit / reject otherwise. Two independent kill paths:
 *
 *  - `timeoutMs` — a hard wall-clock deadline. A git server can accept the TCP
 *    connection then stall indefinitely (slow-loris on smart-HTTP, pathological
 *    pack data); the cooperative-cancel path below only fires on a *user* cancel,
 *    so without this a hung git phase would wedge the single-replica worker
 *    forever and block the whole build queue. On expiry the child is SIGKILLed
 *    and the promise rejects with a `timed out` error (distinct from a non-zero
 *    exit, so the caller/log shows the real cause). Mirrors {@link runKaniko}.
 *  - `signal` — cooperative cancel (SIGTERM, escalating to SIGKILL after a grace
 *    period if the child ignores it).
 *
 * Exported for unit testing (the timeout path is exercised against a real
 * long-running child in runBuild.timeout.test.ts).
 */
export function spawnLogged(
  command: string,
  args: string[],
  opts: {
    onLine: (line: string) => void;
    /** Secret(s) to strip from every emitted line — see {@link redact}. */
    redact: string | string[];
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    /** Hard wall-clock cap; SIGKILL + reject on expiry. Omit to disable. */
    timeoutMs?: number;
  },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: opts.env,
    });

    // Hard timeout: SIGKILL outright (not SIGTERM) — a stalled git over a dead
    // connection may never reap a graceful signal, and we want the worker slot
    // back deterministically. `timedOut` makes the `close` handler report the
    // timeout rather than a misleading "killed by signal" exit code.
    let timedOut = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs !== undefined) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, opts.timeoutMs);
      timeoutTimer.unref?.();
    }

    // Cooperative cancel: SIGTERM the child if the build is being cancelled,
    // escalating to SIGKILL if it doesn't exit within the grace period.
    let killTimer: NodeJS.Timeout | undefined;
    const onAbort = (): void => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), ABORT_KILL_GRACE_MS);
      killTimer.unref?.();
    };
    if (opts.signal) {
      if (opts.signal.aborted) {
        child.kill('SIGTERM');
      } else {
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }
    }
    const detach = (): void => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      opts.signal?.removeEventListener('abort', onAbort);
    };

    let buffer = '';
    const onChunk = (chunk: Buffer | string): void => {
      buffer += chunk.toString();
      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const raw = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (raw.length > 0) opts.onLine(redact(raw, opts.redact));
      }
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);
    child.on('error', (err) => {
      detach();
      reject(err);
    });
    child.on('close', (code) => {
      detach();
      const tail = buffer.trim();
      if (tail.length > 0) opts.onLine(redact(tail, opts.redact));
      if (timedOut) {
        reject(new Error(`${command} ${args[0] ?? ''} timed out after ${opts.timeoutMs}ms`));
        return;
      }
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args[0] ?? ''} exited with code ${code}`));
    });
  });
}

/**
 * Strip every secret in `secret` from a log line before it's persisted. We pass
 * BOTH forms the GitHub token can take: the raw token AND the
 * `AUTHORIZATION: Basic <base64(x-access-token:<token>)>` header value that git
 * actually emits (constructed via {@link authHeaderValue}, so the two can't
 * drift). Without the base64 form, a leaked `Authorization` header would slip
 * through redaction even though it's a working credential. Longest-first so a
 * raw-token substring of the header doesn't pre-empt redacting the wider blob.
 */
export function redact(line: string, secret: string | string[]): string {
  const secrets = (Array.isArray(secret) ? secret : [secret])
    .filter((s) => s.length > 0)
    .sort((a, b) => b.length - a.length);
  let out = line;
  for (const s of secrets) out = out.split(s).join('***');
  return out;
}

// --- Stub path (mirrors M2.5) ---------------------------------------------

/** Sleep that resolves early when `signal` aborts, so a cancel isn't blocked. */
function interruptibleSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function runStubBuild(
  build: BuildWithRelations,
  ctx: RunBuildContext,
  signal: AbortSignal,
): Promise<void> {
  const image = STUB_IMAGES[build.commitSha.charCodeAt(0) % STUB_IMAGES.length]!;

  await ctx.logs.write(
    'STEP',
    `stub: cloning ${build.project.githubRepoFullName}@${build.commitSha.slice(0, 7)}`,
  );
  await interruptibleSleep(1500, signal);
  if (signal.aborted) throw new Error('cancelled');

  await setStatus(ctx.buildId, 'BUILDING', { imageTag: image });
  await ctx.logs.write('STEP', `stub: pretending to build (target image=${image})`);
  await interruptibleSleep(1500, signal);
  if (signal.aborted) throw new Error('cancelled');

  await deployAndRecord(build, ctx, image);
}

// --- Shared deploy step ----------------------------------------------------

async function deployAndRecord(
  build: BuildWithRelations,
  ctx: RunBuildContext,
  image: string,
  resolved?: ResolvedDockerfile,
): Promise<void> {
  await setStatus(ctx.buildId, 'DEPLOYING');

  // Preview / PR build: deploy to the ephemeral per-PR Container App instead of
  // the project's main app, and DON'T create a Deployment row or touch
  // Project.liveUrl. Branch before any main-app logging/work. Truthy check (not
  // `!== null`) so a Build object that merely omits the field can't misroute to
  // the preview path — Prisma always returns null for the unset column.
  if (build.previewId) {
    await deployPreviewAndRecord(build, ctx, image, resolved);
    return;
  }

  await ctx.logs.write(
    'STEP',
    `rolling ${build.project.containerAppName} to ${image}`,
  );

  // Reconcile the Container App's env to the project's declared env vars on
  // every deploy: each value is surfaced as an Azure secret + `secretRef`
  // (encrypted at rest), mirroring how it's stored in the DB. Passing the
  // full list (even empty) keeps the running app's env in lockstep with the
  // project — a deleted var disappears on the next build.
  const envVars = await loadDecryptedEnvVars(build.projectId);
  if (envVars.length > 0) {
    await ctx.logs.write('STEP', `applying ${envVars.length} env var(s) as secrets`);
  }

  // Align the ingress target port with the app's listen port: a generated
  // Dockerfile reports its framework port, and a repo-supplied Dockerfile
  // reports its `EXPOSE` port. Either way ingress stays in lockstep with the
  // app. Only a Dockerfile with no parseable EXPOSE leaves `port` null →
  // ingress untouched (stays at the create-time default of 80).
  const targetPort = resolved?.port ?? undefined;
  if (targetPort !== undefined) {
    await ctx.logs.write('STEP', `routing ingress → port ${targetPort}`);
  }

  const deploy = await updateContainerApp({
    name: build.project.containerAppName,
    image,
    envVars,
    ...(targetPort !== undefined ? { targetPort } : {}),
  });

  const finishedAt = new Date();
  const startedAtMs = build.startedAt?.getTime() ?? finishedAt.getTime();
  const durationMs = finishedAt.getTime() - startedAtMs;

  const fallbackRevision =
    env.BUILD_RUNNER_MODE === 'stub' ? 'stub' : build.commitSha.slice(0, 12);
  const revisionName = deploy.revisionName ?? fallbackRevision;

  // Azure has *already* rolled to `image` at this point. The DB write below must
  // therefore never let a failure here masquerade as a build failure: the build
  // genuinely succeeded (image pushed + Azure live). The `one_active_per_project`
  // partial-unique index can trip P2002 when a concurrent rollback/redeploy (in
  // the API process, see services/deploy.ts) wins the active-deployment slot at
  // the same instant. If we let that P2002 unwind to runBuild's catch, the build
  // would be marked FAILED while the app is live on this exact image — and a
  // stale `active=true` row would mislead the next rollback/redeploy. So we catch
  // P2002 and reconcile: record the build as READY (it succeeded) but write this
  // deployment as a NON-active historical row, since the concurrent deploy now
  // owns the active slot (and the project's liveUrl). Non-P2002 errors still
  // propagate — a real DB failure should still mark the build FAILED.
  try {
    await prisma.$transaction([
      prisma.deployment.updateMany({
        where: { projectId: build.projectId, active: true },
        data: { active: false },
      }),
      prisma.deployment.create({
        data: {
          projectId: build.projectId,
          buildId: build.id,
          revisionName,
          active: true,
        },
      }),
      prisma.build.update({
        where: { id: ctx.buildId },
        data: { status: 'READY', finishedAt, durationMs, imageTag: image },
      }),
      prisma.project.update({
        where: { id: build.projectId },
        data: {
          liveUrl: deploy.liveUrl,
          // Record the auto-detected framework (or clear it when the user ships
          // their own Dockerfile) so the UI can show how the app is built.
          ...(resolved ? { frameworkHint: resolved.framework } : {}),
        },
      }),
    ]);
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) {
      throw err;
    }
    // Won the image+roll, lost the active slot to a concurrent deploy. Reconcile
    // the DB without overwriting the winner's active deployment/liveUrl: still
    // mark this build READY (it succeeded) + record a non-active historical
    // Deployment so the timeline shows this image shipped. We do NOT touch
    // Project.liveUrl/active — the concurrent deploy owns the live state.
    logger.warn(
      { buildId: ctx.buildId, projectId: build.projectId, image },
      'deploy active-slot race (P2002): image is live but another deploy won the active slot — recording build READY with a non-active deployment',
    );
    await ctx.logs.write(
      'WARN',
      'another deployment won the active slot concurrently — recording this build as deployed (historical)',
    );
    await prisma.$transaction([
      prisma.deployment.create({
        data: {
          projectId: build.projectId,
          buildId: build.id,
          revisionName,
          active: false,
        },
      }),
      prisma.build.update({
        where: { id: ctx.buildId },
        data: { status: 'READY', finishedAt, durationMs, imageTag: image },
      }),
    ]);
  }

  await ctx.logs.write('SUCCESS', `deployed → ${deploy.liveUrl}`);
  logger.info(
    { buildId: ctx.buildId, image, liveUrl: deploy.liveUrl },
    'build complete',
  );
}

// --- Preview (PR) deploy step ----------------------------------------------

/**
 * Deploy a preview build to its ephemeral per-PR Container App.
 *
 * Differences from the main-app deploy:
 *  - Targets the PreviewEnvironment's own app name (always min=0/max=1
 *    scale-to-zero — a preview must never inherit an always-on pin).
 *  - Uses `createContainerApp` (an idempotent ACA upsert): the first push
 *    creates the app, later pushes roll it. The image tag is the commit SHA, so
 *    each build is a fresh revision — no revisionSuffix juggling needed.
 *  - Does NOT write a Deployment row and does NOT touch Project.liveUrl — the
 *    preview tracks its own state on the PreviewEnvironment row.
 *  - Stateless v1: reuses the project's runtime env vars (any external DB URL
 *    the owner set), no per-preview database.
 * If the PR closed (preview torn down) mid-build, skips the deploy and just
 * records the build READY — we must not resurrect a torn-down app.
 */
async function deployPreviewAndRecord(
  build: BuildWithRelations,
  ctx: RunBuildContext,
  image: string,
  resolved?: ResolvedDockerfile,
): Promise<void> {
  const finishedAt = new Date();
  const startedAtMs = build.startedAt?.getTime() ?? finishedAt.getTime();
  const durationMs = finishedAt.getTime() - startedAtMs;

  const preview = await prisma.previewEnvironment.findUnique({
    where: { id: build.previewId as string },
  });

  if (preview === null || preview.closedAt !== null || preview.status === 'TORN_DOWN') {
    await ctx.logs.write(
      'WARN',
      'preview environment was closed before deploy — skipping deploy (image built + pushed)',
    );
    await prisma.build.update({
      where: { id: ctx.buildId },
      data: { status: 'READY', finishedAt, durationMs, imageTag: image },
    });
    return;
  }

  await ctx.logs.write(
    'STEP',
    `deploying preview for PR #${preview.prNumber} → ${preview.containerAppName}`,
  );

  const envVars = await loadDecryptedEnvVars(build.projectId);
  if (envVars.length > 0) {
    await ctx.logs.write('STEP', `applying ${envVars.length} env var(s) as secrets`);
  }

  const targetPort = resolved?.port ?? undefined;
  if (targetPort !== undefined) {
    await ctx.logs.write('STEP', `routing ingress → port ${targetPort}`);
  }

  // `createContainerApp` is an idempotent full-replace upsert (createOrUpdate
  // from a freshly-built envelope, NOT a get-merge). On a rebuild it re-pins
  // minReplicas:0/maxReplicas:1 every time, so a preview app can never inherit an
  // always-on pin — but it also means any out-of-band tweak on the preview app is
  // reset each push (intentional for ephemeral previews). If this is ever changed
  // to a merge, re-verify the min=0 guarantee.
  const deploy = await createContainerApp({
    name: preview.containerAppName,
    image,
    envVars,
    minReplicas: 0,
    maxReplicas: 1,
    ...(targetPort !== undefined ? { targetPort } : {}),
  });

  const fallbackRevision =
    env.BUILD_RUNNER_MODE === 'stub' ? 'stub' : build.commitSha.slice(0, 12);
  const revisionName = deploy.revisionName ?? fallbackRevision;
  // Slide the TTL forward on every successful deploy.
  const expiresAt = new Date(Date.now() + env.PREVIEW_TTL_HOURS * 60 * 60 * 1000);
  const activeData = {
    status: 'ACTIVE' as const,
    liveUrl: deploy.liveUrl,
    revisionName,
    lastBuildId: build.id,
    headSha: build.commitSha,
    expiresAt,
  };

  // Azure has ALREADY created/rolled the preview Container App — it is LIVE. The
  // DB writes below must therefore never let a transient failure (the wide-open
  // shared Postgres) masquerade as a build failure: if this threw up to
  // runBuild's catch, the build would be marked FAILED and the preview flipped
  // PENDING→FAILED while its app is actually serving (an orphan the reaper only
  // reclaims on PR-close/TTL). Mirrors the main-path reconcile philosophy
  // (deployAndRecord's P2002 branch): on a post-Azure DB error, log loudly so
  // the live app is greppable, then best-effort record the build READY (it
  // genuinely deployed) + the preview ACTIVE out of band, and do NOT rethrow.
  //
  // The preview write is a conditional compare-and-set on `closedAt IS NULL`
  // (updateMany, not update): if the PR was CLOSED while the slow
  // createContainerApp call above was in flight, teardownPreview already deleted
  // the app AND set closedAt/TORN_DOWN — but our idempotent create re-spawned the
  // app it deleted. The guard matches 0 rows in that case, so we never resurrect
  // a torn-down row to ACTIVE; instead we tear the re-created app down again
  // below.
  //
  // `confirmedClosed` is set ONLY when the conditional write *ran successfully*
  // and matched 0 rows — positive proof the PR closed. A thrown DB error leaves
  // the state unknown, and we must NOT delete the (live) app on a transient
  // error — that would turn a bookkeeping blip into destroying a healthy preview.
  // The TTL reaper is the backstop for the unknown case.
  let confirmedClosed = false;
  try {
    const [previewResult] = await prisma.$transaction([
      prisma.previewEnvironment.updateMany({
        where: { id: preview.id, closedAt: null },
        data: activeData,
      }),
      prisma.build.update({
        where: { id: ctx.buildId },
        data: { status: 'READY', finishedAt, durationMs, imageTag: image },
      }),
    ]);
    confirmedClosed = previewResult.count === 0;
  } catch (err) {
    logger.error(
      {
        err,
        buildId: ctx.buildId,
        previewId: preview.id,
        containerAppName: preview.containerAppName,
        liveUrl: deploy.liveUrl,
      },
      'preview deploy: Azure app is LIVE but the DB transaction failed — reconciling build READY + preview ACTIVE out of band',
    );
    await ctx.logs.write(
      'WARN',
      'preview deployed, but recording its state hit a database error — the app is live; reconciling',
    );
    // Build first: getting it terminal (READY) keeps the runner's finally-net
    // from force-FAILING a build whose image is live + serving.
    await prisma.build
      .update({
        where: { id: ctx.buildId },
        data: { status: 'READY', finishedAt, durationMs, imageTag: image },
      })
      .catch((e: unknown) =>
        logger.error({ err: e, buildId: ctx.buildId }, 'preview deploy reconcile: build READY update failed'),
      );
    try {
      const reconciled = await prisma.previewEnvironment.updateMany({
        where: { id: preview.id, closedAt: null },
        data: activeData,
      });
      confirmedClosed = reconciled.count === 0;
    } catch (e: unknown) {
      // State unknown — leave the live app in place (do NOT delete on a transient
      // error); the reaper reclaims it on PR-close/TTL.
      logger.error(
        { err: e, previewId: preview.id },
        'preview deploy reconcile: preview ACTIVE update failed — leaving the live app (TTL reaper backstops)',
      );
    }
  }

  if (confirmedClosed) {
    // The PR was closed (preview torn down) while createContainerApp was in
    // flight: teardown deleted the app + set closedAt, but our idempotent create
    // re-spawned it. Delete it again and leave the row TORN_DOWN — we must never
    // resurrect a closed preview (the orphan/cost-leak the close check guards
    // against). Best-effort; the TTL reaper is the backstop.
    await ctx.logs.write(
      'WARN',
      'preview was closed mid-deploy — removing the re-created app (PR already closed)',
    );
    logger.warn(
      { buildId: ctx.buildId, previewId: preview.id, containerAppName: preview.containerAppName },
      'preview closed mid-deploy; deleting the re-created container app',
    );
    await deleteContainerApp(preview.containerAppName).catch((e: unknown) =>
      logger.error(
        { err: e, containerAppName: preview.containerAppName },
        'preview close-race cleanup: deleteContainerApp failed (TTL reaper is the backstop)',
      ),
    );
    return;
  }

  await ctx.logs.write('SUCCESS', `preview deployed → ${deploy.liveUrl}`);
  logger.info(
    { buildId: ctx.buildId, previewId: preview.id, prNumber: preview.prNumber, liveUrl: deploy.liveUrl },
    'preview build complete',
  );
}

function requireAcrName(): string {
  if (!env.ACR_NAME) {
    throw new Error('ACR_NAME not configured — required for real builds');
  }
  return env.ACR_NAME;
}
