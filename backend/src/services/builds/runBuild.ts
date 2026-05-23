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
import { updateContainerApp } from '../azure/index.js';
import { runKaniko } from './kaniko.js';

const STUB_IMAGES = [
  'mcr.microsoft.com/k8se/quickstart:latest',
  'nginxdemos/hello:latest',
] as const;

const MAX_LOG_LINES_PER_BUILD = 50_000;
const LOG_LINE_MAX_BYTES = 8 * 1024;

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

  try {
    await mkdir(workDir, { recursive: true, mode: 0o700 });
    await mkdir(authDir, { recursive: true, mode: 0o700 });
    await setStatus(buildId, 'CLONING', { startedAt });

    if (env.BUILD_RUNNER_MODE === 'stub') {
      await runStubBuild(build, ctx);
    } else {
      await runRealBuild(build, ctx);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, buildId }, 'build failed');
    await ctx.logs.write('ERROR', `build failed: ${message}`);
    await setStatus(buildId, 'FAILED', {
      finishedAt: new Date(),
      errorMessage: message,
    });
  } finally {
    // Drain any fire-and-forget log writes before the runner returns —
    // otherwise the trailing lines (npm error output before kaniko bails,
    // git's final fatal: …, etc.) race with `prisma.$disconnect()` in
    // single-use mode and the UI shows truncated logs.
    await ctx.logs.flush();
    await rm(workDir, { recursive: true, force: true }).catch((err: unknown) => {
      logger.warn({ err, workDir }, 'failed to clean up build work dir');
    });
  }
}

// --- Real (kaniko) path ----------------------------------------------------

type BuildWithRelations = Prisma.BuildGetPayload<{
  include: { project: { include: { user: true } } };
}>;

async function runRealBuild(build: BuildWithRelations, ctx: RunBuildContext): Promise<void> {
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
    onLine: (line) => {
      ctx.logs.emit(classifyLine(line), `git: ${line}`);
    },
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

  const dockerfile = path.join(ctx.repoDir, 'Dockerfile');
  const result = await runKaniko({
    contextDir: ctx.repoDir,
    authDir: ctx.authDir,
    dockerfile,
    destinations: [shaTag, latestTag],
    timeoutMs: env.BUILD_TIMEOUT_MS,
    onLine: (line, stream) => {
      ctx.logs.emit(classifyLine(line), `${stream}: ${line}`);
    },
  });

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

  await deployAndRecord(build, ctx, shaTag);
}

async function cloneRepo(opts: {
  repoFullName: string;
  branch: string;
  commitSha: string;
  token: string;
  intoDir: string;
  onLine: (line: string) => void;
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
  const url = `https://github.com/${opts.repoFullName}.git`;
  const authConfig = `http.${url}.extraheader=AUTHORIZATION: Basic ${basicAuth(opts.token)}`;
  // `credential.helper=` disables ALL credential helpers and
  // `GIT_TERMINAL_PROMPT=0` makes any prompt attempt fail fast. Even with
  // both, git 2.x still prints one `fatal: could not read Username for
  // 'https://github.com': terminal prompts disabled` line to stderr when the
  // server challenges auth — outside of git's control. The actual clone
  // outcome is captured by the exit code; the line is cosmetic noise we
  // drop in `gitOnLine` below.
  const noCredHelper = 'credential.helper=';
  const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
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
      ['-c', noCredHelper, '-c', authConfig, 'clone', '--depth', '1', '--branch', opts.branch, url, opts.intoDir],
      { onLine: gitOnLine, redact: opts.token, env: gitEnv },
    );
  } catch (err) {
    opts.onLine(`git: authenticated clone failed (${(err as Error).message}); retrying anonymously`);
    await rm(opts.intoDir, { recursive: true, force: true });
    await spawnLogged(
      'git',
      ['-c', noCredHelper, 'clone', '--depth', '1', '--branch', opts.branch, url, opts.intoDir],
      { onLine: gitOnLine, redact: opts.token, env: gitEnv },
    );
  }

  // `--depth 1` may not give us the exact commit if HEAD has advanced since
  // the webhook fired. Fetch + checkout makes the build reproducible.
  await spawnLogged(
    'git',
    [
      '-C',
      opts.intoDir,
      '-c',
      noCredHelper,
      '-c',
      authConfig,
      'fetch',
      '--depth',
      '1',
      'origin',
      opts.commitSha,
    ],
    { onLine: gitOnLine, redact: opts.token, env: gitEnv },
  ).catch(() => {
    // Older git servers reject single-sha fetch; the shallow clone above is
    // good enough when HEAD hasn't moved. Continue.
  });
  await spawnLogged('git', ['-C', opts.intoDir, 'checkout', opts.commitSha], {
    onLine: gitOnLine,
    redact: opts.token,
    env: gitEnv,
  }).catch(() => {
    // Same fallback — if checkout fails the shallow HEAD is what we'll build.
  });
}

function basicAuth(token: string): string {
  return Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
}

function spawnLogged(
  command: string,
  args: string[],
  opts: {
    onLine: (line: string) => void;
    redact: string;
    env?: NodeJS.ProcessEnv;
  },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: opts.env,
    });
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
    child.on('error', reject);
    child.on('close', (code) => {
      const tail = buffer.trim();
      if (tail.length > 0) opts.onLine(redact(tail, opts.redact));
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args[0] ?? ''} exited with code ${code}`));
    });
  });
}

function redact(line: string, secret: string): string {
  if (secret.length === 0) return line;
  return line.split(secret).join('***');
}

// --- Stub path (mirrors M2.5) ---------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function runStubBuild(build: BuildWithRelations, ctx: RunBuildContext): Promise<void> {
  const image = STUB_IMAGES[build.commitSha.charCodeAt(0) % STUB_IMAGES.length]!;

  await ctx.logs.write(
    'STEP',
    `stub: cloning ${build.project.githubRepoFullName}@${build.commitSha.slice(0, 7)}`,
  );
  await sleep(1500);

  await setStatus(ctx.buildId, 'BUILDING', { imageTag: image });
  await ctx.logs.write('STEP', `stub: pretending to build (target image=${image})`);
  await sleep(1500);

  await deployAndRecord(build, ctx, image);
}

// --- Shared deploy step ----------------------------------------------------

async function deployAndRecord(
  build: BuildWithRelations,
  ctx: RunBuildContext,
  image: string,
): Promise<void> {
  await setStatus(ctx.buildId, 'DEPLOYING');
  await ctx.logs.write(
    'STEP',
    `rolling ${build.project.containerAppName} to ${image}`,
  );

  const deploy = await updateContainerApp({
    name: build.project.containerAppName,
    image,
  });

  const finishedAt = new Date();
  const startedAtMs = build.startedAt?.getTime() ?? finishedAt.getTime();
  const durationMs = finishedAt.getTime() - startedAtMs;

  await prisma.$transaction([
    prisma.deployment.updateMany({
      where: { projectId: build.projectId, active: true },
      data: { active: false },
    }),
    prisma.deployment.create({
      data: {
        projectId: build.projectId,
        buildId: build.id,
        revisionName: env.BUILD_RUNNER_MODE === 'stub' ? 'stub' : build.commitSha.slice(0, 12),
        active: true,
      },
    }),
    prisma.build.update({
      where: { id: ctx.buildId },
      data: { status: 'READY', finishedAt, durationMs, imageTag: image },
    }),
    prisma.project.update({
      where: { id: build.projectId },
      data: { liveUrl: deploy.liveUrl },
    }),
  ]);

  await ctx.logs.write('SUCCESS', `deployed → ${deploy.liveUrl}`);
  logger.info(
    { buildId: ctx.buildId, image, liveUrl: deploy.liveUrl },
    'build complete',
  );
}

function requireAcrName(): string {
  if (!env.ACR_NAME) {
    throw new Error('ACR_NAME not configured — required for real builds');
  }
  return env.ACR_NAME;
}
