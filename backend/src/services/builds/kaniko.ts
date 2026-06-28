/**
 * Kaniko wrapper.
 *
 * `runKaniko()` does the build+push in one shot — kaniko has no separate
 * push step, the `--destination` flags drive both.
 *
 * Two invocation modes share one stdout/stderr streaming contract:
 *
 *  - `docker`: `docker run --rm gcr.io/kaniko-project/executor:<tag> …`,
 *    so a laptop without git/kaniko binaries can still build. Used in dev.
 *  - `kaniko`: the binary lives at `/kaniko/executor` inside the
 *    prodstack-builder image. No docker daemon needed; this is what runs
 *    in prod on Azure Container Apps.
 *
 * ACR push auth in both modes is a `config.json` written to a docker-config
 * dir we mount into the kaniko container. Managed identity isn't available
 * to kaniko (it speaks the docker registry protocol, not Azure AD), so we
 * fall back to ACR admin creds — same path as the M2 manual push.
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { env } from '../../env.js';

// Only used by the `docker` runner mode (local dev). The prod `kaniko` mode
// invokes the in-image `/kaniko/executor` binary instead (see worker/Dockerfile,
// pinned to v1.24.0 by Dependabot #23). Keep this tag in lockstep with that
// FROM so local docker-mode builds match what ships in the builder image.
const KANIKO_IMAGE = 'gcr.io/kaniko-project/executor:v1.24.0';

/** Grace period after an abort's SIGTERM before escalating to SIGKILL. */
const ABORT_KILL_GRACE_MS = 10_000;

/**
 * ACR repo-path prefix for the registry layer cache (docs/BUILD_CACHE.md). The
 * builder pushes cache layers under `${prefix}<projectId>` (runBuild.ts) and the
 * image GC keys the shorter `RETENTION_DAYS_CACHE` window off the same prefix
 * (cleanupImages.ts) — this one constant is the cross-module contract between
 * the producer and the GC, so they can never drift out of lockstep.
 */
export const BUILD_CACHE_REPO_PREFIX = 'buildcache/';

export interface KanikoOptions {
  contextDir: string;
  /**
   * Sibling dir of `contextDir` used for files that must NOT be visible to
   * the user's Dockerfile (notably ACR push creds). MUST NOT overlap with
   * `contextDir` or its parents — otherwise a `COPY . .` in the user's
   * Dockerfile would bake those secrets into the published image.
   */
  authDir: string;
  dockerfile: string;
  destinations: string[];
  /**
   * Build-time-public env vars (e.g. `NEXT_PUBLIC_*`) passed to the build as
   * `--build-arg`. These end up inlined into the image, so ONLY values that are
   * public by design belong here — never runtime secrets. The generated
   * Dockerfile declares matching `ARG`s; a user's own Dockerfile must declare
   * its own (kaniko silently ignores a `--build-arg` with no matching `ARG`).
   */
  buildArgs?: Array<{ name: string; value: string }>;
  /** Called once per line of stdout/stderr emitted by kaniko. */
  onLine: (line: string, stream: 'stdout' | 'stderr') => void;
  /**
   * Secret values stripped from every stdout/stderr line BEFORE it reaches
   * `onLine` (and therefore the persisted `LogLine` + the live SSE stream).
   * Mirrors the git phase's `spawnLogged({ redact })`: kaniko reads our docker
   * config (ACR push password + Docker Hub pull token) and can echo parts of it
   * on a registry error, so the caller seeds this with every sensitive value the
   * worker holds. Applied with the shared {@link redact} helper (longest-first).
   * Omitted/empty → no redaction (byte-identical to the pre-redaction behaviour).
   */
  redactSecrets?: string[];
  /** Hard timeout; killed with SIGKILL if exceeded. */
  timeoutMs: number;
  signal?: AbortSignal;
  /**
   * Registry-backed layer cache (docs/BUILD_CACHE.md). When set, Kaniko pushes
   * each built layer to `repo` (an ACR path keyed per project) and pulls it on
   * the next build instead of rebuilding — surviving the scale-to-zero builder
   * because the cache lives in ACR, not on local disk. Setting this also DROPS
   * `--single-snapshot` (which collapses the image into one layer and defeats
   * per-layer caching). Unset → byte-identical argv to the pre-cache build.
   */
  cache?: { repo: string; ttl: string };
}

export interface KanikoResult {
  exitCode: number;
  timedOut: boolean;
}

/**
 * Build + push to every `destination`. Resolves with the kaniko exit code;
 * the caller decides what counts as a failure (any non-zero, by convention).
 */
export async function runKaniko(opts: KanikoOptions): Promise<KanikoResult> {
  if (env.BUILD_RUNNER_MODE === 'stub') {
    throw new Error('runKaniko called with BUILD_RUNNER_MODE=stub — caller should branch earlier');
  }

  assertAuthDirIsolated(opts.contextDir, opts.authDir);
  const dockerConfigDir = await writeDockerConfig(opts.authDir);

  const { command, args, env: childEnv } = buildCommand(opts, dockerConfigDir);
  return spawnAndStream(command, args, childEnv, opts);
}

/**
 * Guard against the trap of placing the ACR-cred docker config inside the
 * kaniko build context — a `COPY . .` in the user's Dockerfile would then
 * bake the registry password into the published image.
 */
export function assertAuthDirIsolated(contextDir: string, authDir: string): void {
  const ctx = path.resolve(contextDir);
  const auth = path.resolve(authDir);
  const rel = path.relative(ctx, auth);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    throw new Error(
      `kaniko authDir ${JSON.stringify(authDir)} must not live inside contextDir ${JSON.stringify(contextDir)} — ACR creds would leak into the user's image`,
    );
  }
}

/**
 * Registry auth: write `<authDir>/.docker/config.json` with basic-auth creds,
 * then mount/point kaniko at that dir. The structure matches what `docker login`
 * produces, which is what kaniko reads. Two registries:
 *
 *  - ACR (always): the `--destination` *push* target. Kaniko can't use the
 *    managed identity for `docker push`, so it needs a username/password pair.
 *  - Docker Hub (optional, when DOCKERHUB_USERNAME/TOKEN are set): the base-image
 *    *pull* source. Anonymous Docker Hub pulls are rate-limited per source IP,
 *    and the builder shares Azure's outbound IP pool with other tenants, so
 *    anonymous pulls of `FROM node:20-slim` &c. intermittently fail with
 *    `TOOMANYREQUESTS: unauthenticated pull rate limit`. Authenticating moves the
 *    limit to a per-account quota. Unset → no entry, anonymous pulls exactly as
 *    before (backward compatible).
 *
 * `authDir` is a sibling of the kaniko context, never inside it.
 */
export async function writeDockerConfig(authDir: string): Promise<string> {
  const dir = path.join(authDir, '.docker');
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const registry = `${requireAcrName()}.azurecr.io`;
  const auth = Buffer.from(
    `${requireAcrUsername()}:${requireAcrPassword()}`,
    'utf8',
  ).toString('base64');

  const auths: Record<string, { auth: string }> = {
    [registry]: { auth },
  };

  // The key MUST be exactly `https://index.docker.io/v1/`: go-containerregistry
  // (kaniko's registry client) resolves the default Docker Hub registry against
  // that canonical string, not `docker.io` / `index.docker.io`. This is the same
  // entry `docker login` writes for Docker Hub.
  if (env.DOCKERHUB_USERNAME && env.DOCKERHUB_TOKEN) {
    const dockerHubAuth = Buffer.from(
      `${env.DOCKERHUB_USERNAME}:${env.DOCKERHUB_TOKEN}`,
      'utf8',
    ).toString('base64');
    auths['https://index.docker.io/v1/'] = { auth: dockerHubAuth };
  }

  const config = { auths };
  await writeFile(path.join(dir, 'config.json'), JSON.stringify(config), { mode: 0o600 });
  return dir;
}

/**
 * Render build-time-public vars as kaniko/docker `--build-arg` flags. One
 * `--build-arg=NAME=VALUE` token per var (single argv element, so spaces/`=` in
 * the value are safe — nothing reaches a shell). Identical syntax for the
 * kaniko binary and the kaniko image, so both invocation modes reuse this.
 */
export function buildArgFlags(buildArgs: KanikoOptions['buildArgs'] = []): string[] {
  return buildArgs.map((a) => `--build-arg=${a.name}=${a.value}`);
}

/**
 * Layer-snapshot flags. Caching and `--single-snapshot` are mutually exclusive:
 * `--single-snapshot` collapses the image into ONE layer, which defeats per-layer
 * caching, so when a registry cache is configured we drop it and emit the cache
 * flags instead. With no cache we keep `--single-snapshot` exactly as before, so
 * the argv is byte-identical to the pre-cache build (the flag's literal position
 * in `buildCommand` is preserved). Shared by both runner modes.
 */
export function cacheOrSnapshotFlags(cache: KanikoOptions['cache']): string[] {
  if (!cache) return ['--single-snapshot'];
  return ['--cache=true', `--cache-repo=${cache.repo}`, `--cache-ttl=${cache.ttl}`];
}

/**
 * Non-secret env vars the spawned build process is allowed to inherit. Kaniko
 * runs UNTRUSTED user-Dockerfile `RUN` steps, so it must NOT receive the worker's
 * full `process.env` — that would hand a hostile Dockerfile every platform secret
 * (ACR_PASSWORD, DATABASE_URL, DATA_ENC_KEY, JWT_SECRET, COOKIE_SECRET,
 * DOCKERHUB_TOKEN, DEPLOY_TOKEN, ADMIN_TOKEN, …). Only these load-bearing,
 * non-secret vars pass through; the caller adds the few it genuinely needs (e.g.
 * DOCKER_CONFIG for the push creds) via {@link buildChildEnv}'s `extra`.
 *
 *  - PATH/HOME      — the executor needs to find binaries + a home directory.
 *  - HTTP(S)_PROXY / NO_PROXY (+ lowercase) — corporate-proxy egress to the
 *    registries (ACR / Docker Hub), forwarded only when present.
 *  - DOCKER_HOST / DOCKER_TLS_VERIFY / DOCKER_CERT_PATH — docker-mode ONLY: how
 *    the `docker` CLI reaches its daemon. Rootless/remote dev setups export
 *    DOCKER_HOST (e.g. `unix:///run/user/<uid>/docker.sock`); without it a
 *    docker-mode build on such a host can't connect. Non-secret; simply absent in
 *    the prod kaniko mode, so it costs the real exposure nothing.
 */
const CHILD_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'DOCKER_HOST',
  'DOCKER_TLS_VERIFY',
  'DOCKER_CERT_PATH',
] as const;

/**
 * Build the MINIMAL child environment for the spawned build process: only the
 * {@link CHILD_ENV_ALLOWLIST} vars present in `source` (default `process.env`),
 * plus any `extra` the caller injects (which wins on a key clash). Pure +
 * exported with an injectable `source` so the allow-list can be unit-tested
 * without mutating the real process env.
 */
export function buildChildEnv(
  extra: NodeJS.ProcessEnv = {},
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of CHILD_ENV_ALLOWLIST) {
    const value = source[key];
    if (value !== undefined) out[key] = value;
  }
  return { ...out, ...extra };
}

export function buildCommand(
  opts: KanikoOptions,
  dockerConfigDir: string,
): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  if (env.BUILD_RUNNER_MODE === 'docker') {
    const args = [
      'run',
      '--rm',
      '-v',
      `${opts.contextDir}:/workspace:ro`,
      '-v',
      `${dockerConfigDir}:/kaniko/.docker:ro`,
      KANIKO_IMAGE,
      '--context=dir:///workspace',
      `--dockerfile=${path.posix.join('/workspace', path.relative(opts.contextDir, opts.dockerfile))}`,
      ...cacheOrSnapshotFlags(opts.cache),
      ...buildArgFlags(opts.buildArgs),
      ...opts.destinations.map((d) => `--destination=${d}`),
    ];
    // `docker run` does not forward the host env into the built container, but we
    // still hand the `docker` CLI itself only the minimal allow-list (defense in
    // depth) — the ACR/Docker Hub creds reach kaniko via the mounted config dir.
    return { command: 'docker', args, env: buildChildEnv() };
  }

  // BUILD_RUNNER_MODE === 'kaniko'. Pass DOCKER_CONFIG in the child env so
  // we don't mutate the parent process (concurrent builds, tests, etc) — and via
  // the minimal allow-list so the untrusted Dockerfile's `RUN` steps never see
  // any platform secret from the worker's process.env.
  //
  // `--ignore-path=BUILD_WORK_DIR`: kaniko's stage-transition `DeleteFilesystem`
  // walks `/` and `os.RemoveAll`s anything not on its ignore list. Without
  // this flag a multi-stage Dockerfile's second-stage `COPY <src>` from the
  // local context fails with `lstat … no such file or directory` because the
  // clone at `${BUILD_WORK_DIR}/<buildId>/repo` gets wiped between stages.
  return {
    command: '/kaniko/executor',
    args: [
      `--context=dir://${opts.contextDir}`,
      `--dockerfile=${opts.dockerfile}`,
      `--ignore-path=${env.BUILD_WORK_DIR}`,
      ...cacheOrSnapshotFlags(opts.cache),
      ...buildArgFlags(opts.buildArgs),
      ...opts.destinations.map((d) => `--destination=${d}`),
    ],
    env: buildChildEnv({ DOCKER_CONFIG: dockerConfigDir }),
  };
}

function spawnAndStream(
  command: string,
  args: string[],
  childEnv: NodeJS.ProcessEnv,
  opts: KanikoOptions,
): Promise<KanikoResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv });
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs);
    // Don't let the hard-timeout timer keep the (single-use) worker process
    // alive past a clean exit — mirrors `spawnLogged` in runBuild.ts. Without
    // this, a path where `close`/`error` never fires would leave a live
    // 10-minute timer pinning the event loop and delaying the worker's self-exit.
    timer.unref?.();

    // On abort, SIGTERM the child and escalate to SIGKILL if it hasn't exited
    // within the grace period. kaniko can be unresponsive to SIGTERM mid-
    // snapshot, and in docker mode the `docker run` CLI doesn't reliably
    // forward the signal — without the escalation a cancelled build would hog
    // the single-replica builder's slot until the hard build timeout.
    let killTimer: NodeJS.Timeout | undefined;
    const onAbort = (): void => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), ABORT_KILL_GRACE_MS);
      killTimer.unref?.();
    };
    if (opts.signal) {
      if (opts.signal.aborted) {
        clearTimeout(timer);
        child.kill('SIGKILL');
        reject(new Error('kaniko aborted before start'));
        return;
      }
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    // Redact every secret the worker holds out of kaniko's output BEFORE it
    // reaches onLine — same contract the git phase gets from `spawnLogged`.
    const redactSecrets = opts.redactSecrets ?? [];
    streamLines(child.stdout, (line) => opts.onLine(line, 'stdout'), redactSecrets);
    streamLines(child.stderr, (line) => opts.onLine(line, 'stderr'), redactSecrets);

    child.on('error', (err) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      // Best-effort: if the process half-spawned (e.g. EAGAIN/ENOMEM under the
      // builder's memory pressure) make sure it can't linger. A no-op when there
      // is no live child (spawn ENOENT).
      child.kill('SIGKILL');
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ exitCode: code ?? -1, timedOut });
    });
  });
}

function streamLines(
  stream: NodeJS.ReadableStream | null,
  onLine: (line: string) => void,
  redactSecrets: string[] = [],
): void {
  if (!stream) return;
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      // Redact the assembled line. Both this per-line path and the trailing
      // `end` (truncation/no-final-newline) path below strip secrets.
      if (line.length > 0) onLine(redact(line, redactSecrets));
    }
  });
  stream.on('end', () => {
    const tail = buffer.trim();
    if (tail.length > 0) onLine(redact(tail, redactSecrets));
  });
}

/**
 * Strip every secret in `secret` from a log line before it is emitted (persisted
 * as a `LogLine` + streamed over SSE). Shared by the git phase (`spawnLogged` in
 * runBuild.ts — the raw GitHub token AND the `AUTHORIZATION: Basic …` header it
 * sends) and the kaniko phase ({@link streamLines} above — the ACR push password
 * and Docker Hub pull token kaniko can echo on a registry error). Secrets are
 * stripped LONGEST-FIRST so a shorter secret that is a substring of a longer one
 * (e.g. a raw token inside its own base64 auth blob) doesn't pre-empt redacting
 * the wider value. Empty strings are ignored (a `''` secret would replace between
 * every character). Lives here, the lower-level module runBuild.ts depends on, so
 * both phases reuse one implementation with no import cycle.
 */
export function redact(line: string, secret: string | string[]): string {
  const secrets = (Array.isArray(secret) ? secret : [secret])
    .filter((s) => s.length > 0)
    .sort((a, b) => b.length - a.length);
  let out = line;
  for (const s of secrets) out = out.split(s).join('***');
  return out;
}

function requireAcrName(): string {
  if (!env.ACR_NAME) {
    throw new Error('ACR_NAME not configured — set it before running a real build');
  }
  return env.ACR_NAME;
}

function requireAcrUsername(): string {
  if (!env.ACR_USERNAME) {
    throw new Error('ACR_USERNAME not configured — required for kaniko push auth');
  }
  return env.ACR_USERNAME;
}

function requireAcrPassword(): string {
  if (!env.ACR_PASSWORD) {
    throw new Error('ACR_PASSWORD not configured — required for kaniko push auth');
  }
  return env.ACR_PASSWORD;
}
