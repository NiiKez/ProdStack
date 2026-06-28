// Build FAILURE path — the gap every other runBuild test leaves open.
//
// All sibling runBuild tests pin BUILD_RUNNER_MODE=stub, which bypasses
// `runRealBuild` entirely. So the two most common real-world failure outcomes —
// kaniko exits non-zero, or the build times out — and the resulting transition to
// a terminal FAILED status are never exercised. This suite forces NON-stub
// ('kaniko') mode so `runRealBuild` genuinely runs, then mocks ONLY the true
// external boundaries:
//
//   - node:child_process `spawn`  → the git-clone seam (resolves "cloned" w/o a network)
//   - ./kaniko.js `runKaniko`     → the build itself (we return failing results)
//   - ../../db.js (prisma)        → status persistence (we capture build.update args)
//   - ../azure/index.js           → the deploy chokepoint (assert NEVER called on failure)
//   - ../projectEnv.js / crypto   → token decrypt + env load (no real secrets)
//   - ./resolveDockerfile.js      → Dockerfile pick (no real fs walk)
//   - node:fs/promises mkdir/rm   → workdir setup/cleanup (no real fs)
//
// runBuild's OWN logic is never mocked: it really reads env.BUILD_RUNNER_MODE,
// dispatches to runRealBuild, drives clone→resolve→BUILDING→runKaniko, evaluates
// `result.timedOut`/`result.exitCode`, throws the real error string, and its catch
// writes FAILED. We assert on the captured prisma `build.update` call. This is the
// inverse of a tautology — the function under test runs for real.

import { EventEmitter } from 'node:events';

import { vi } from 'vitest';

// ESM hoists `import`s above plain statements, so env that must be set BEFORE
// env.ts evaluates (at the first `import` of a module that pulls it in) goes in a
// vi.hoisted() block — which runs before the imports. `kaniko` makes runRealBuild
// run; ACR_NAME gets us past runRealBuild's `requireAcrName()` guard to runKaniko.
vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.WEB_ORIGIN = 'http://localhost:5173';
  process.env.PUBLIC_API_URL = 'http://localhost:3000';
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  process.env.JWT_SECRET = 'test-jwt-secret-test-jwt-secret-test-jwt-secret';
  process.env.COOKIE_SECRET = 'test-cookie-secret-test-cookie-secret-test-cookie';
  process.env.DATA_ENC_KEY = Buffer.alloc(32, 9).toString('base64');
  process.env.GITHUB_OAUTH_CLIENT_ID = 'test-client-id';
  process.env.GITHUB_OAUTH_CLIENT_SECRET = 'test-client-secret';
  process.env.GITHUB_OAUTH_CALLBACK_URL = 'http://localhost:3000/api/auth/github/callback';
  process.env.AZURE_STUB = 'true';
  process.env.LOG_LEVEL = 'silent';
  // The crux: NON-stub mode so runRealBuild (not runStubBuild) executes.
  process.env.BUILD_RUNNER_MODE = 'kaniko';
  process.env.BUILD_WORK_DIR = '/tmp/prodstack-builds-test';
  // Past runRealBuild's `requireAcrName()` + kaniko-cred guards (kaniko itself is
  // mocked, but runBuild.ts reads ACR_NAME directly before calling it).
  process.env.ACR_NAME = 'prodstacktest';
  process.env.ACR_USERNAME = 'prodstacktest';
  process.env.ACR_PASSWORD = 'acr-password';
  process.env.BUILD_TIMEOUT_MS = '600000';
});

import { beforeEach, describe, expect, it } from 'vitest';

const mocks = vi.hoisted(() => ({
  buildFindUniqueOrThrow: vi.fn(),
  buildFindUnique: vi.fn(),
  buildUpdate: vi.fn(),
  buildUpdateMany: vi.fn(),
  logLineCreate: vi.fn(),
  deploymentUpdateMany: vi.fn(),
  deploymentCreate: vi.fn(),
  projectUpdate: vi.fn(),
  $transaction: vi.fn(),
  updateContainerApp: vi.fn(),
  loadDecryptedEnvVars: vi.fn(),
  decrypt: vi.fn(),
  resolveDockerfile: vi.fn(),
  runKaniko: vi.fn(),
  spawn: vi.fn(),
  mkdir: vi.fn(),
  rm: vi.fn(),
}));

vi.mock('../../db.js', () => ({
  prisma: {
    build: {
      findUniqueOrThrow: mocks.buildFindUniqueOrThrow,
      findUnique: mocks.buildFindUnique,
      update: mocks.buildUpdate,
      updateMany: mocks.buildUpdateMany,
    },
    logLine: { create: mocks.logLineCreate },
    deployment: { updateMany: mocks.deploymentUpdateMany, create: mocks.deploymentCreate },
    project: { update: mocks.projectUpdate },
    $transaction: mocks.$transaction,
  },
}));

// Deploy chokepoint — must NEVER be reached on a failed build.
vi.mock('../azure/index.js', () => ({ updateContainerApp: mocks.updateContainerApp }));
vi.mock('../projectEnv.js', () => ({ loadDecryptedEnvVars: mocks.loadDecryptedEnvVars }));
// Token decrypt — runRealBuild decrypts the user's GitHub token before cloning.
vi.mock('../../lib/crypto.js', () => ({ decrypt: mocks.decrypt }));
// Dockerfile resolution — skip the real fs walk / framework detection.
vi.mock('./resolveDockerfile.js', () => ({ resolveDockerfile: mocks.resolveDockerfile }));
// The build itself — our controlled seam. Returns failing KanikoResults. Mock
// ONLY runKaniko via importOriginal: runBuild's git path (`spawnLogged`) imports
// the real `redact` from this same module, so a bare object mock would drop it
// and crash every clone line with "No redact export".
vi.mock('./kaniko.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./kaniko.js')>();
  return { ...actual, runKaniko: mocks.runKaniko };
});

// The git-clone seam: runBuild's `cloneRepo` shells out to `git` via
// node:child_process `spawn`. Mock it so every git invocation "succeeds"
// (close code 0) without a network/filesystem. We keep the rest of
// node:child_process intact via importActual.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: mocks.spawn };
});

// Don't create/remove real directories for the build workdir.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, mkdir: mocks.mkdir, rm: mocks.rm };
});

const { runBuild } = await import('./runBuild.js');

/**
 * A fake `git` child process that immediately closes with the given exit code.
 * Optionally emits a single stdout line first (used to drive `git rev-parse HEAD`
 * to a specific sha for the wrong-commit integrity guard).
 */
function fakeGitChild(
  exitCode = 0,
  stdoutLine?: string,
): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void } {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  // Emit on the next tick so the listeners registered synchronously by
  // spawnLogged are attached before we fire.
  setImmediate(() => {
    if (stdoutLine !== undefined) child.stdout.emit('data', `${stdoutLine}\n`);
    child.emit('close', exitCode);
  });
  return child;
}

function buildRow(over: Record<string, unknown> = {}) {
  return {
    id: 'build-1',
    projectId: 'project-1',
    commitSha: 'abc1234def5678',
    branch: 'main',
    startedAt: new Date('2026-06-13T00:00:00Z'),
    project: {
      id: 'project-1',
      containerAppName: 'octocat-app',
      githubRepoFullName: 'octocat/app',
      user: {
        // decrypt() is mocked, so these can be empty placeholders.
        githubTokenCiphertext: Buffer.alloc(0),
        githubTokenIv: Buffer.alloc(0),
        githubTokenAuthTag: Buffer.alloc(0),
        githubTokenKeyVersion: 1,
      },
    },
    ...over,
  };
}

/** All `status` values written via `prisma.build.update`, in call order. */
function statusWrites(): string[] {
  return mocks.buildUpdate.mock.calls
    .map((c) => (c[0] as { data?: { status?: string } }).data?.status)
    .filter((s): s is string => typeof s === 'string');
}

/** The `data` of the terminal status write (the LAST build.update call). */
function terminalUpdate(): { status?: string; errorMessage?: string } {
  const last = mocks.buildUpdate.mock.calls.at(-1);
  return (last?.[0] as { data?: { status?: string; errorMessage?: string } })?.data ?? {};
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.buildFindUniqueOrThrow.mockResolvedValue(buildRow());
  mocks.buildFindUnique.mockResolvedValue({ cancelRequested: false });
  mocks.buildUpdate.mockResolvedValue({});
  // The finally-block terminal reconcile is a no-op on these paths (the catch
  // already writes FAILED) — it must find 0 non-terminal rows to flip.
  mocks.buildUpdateMany.mockResolvedValue({ count: 0 });
  mocks.logLineCreate.mockResolvedValue({});
  mocks.loadDecryptedEnvVars.mockResolvedValue([]);
  mocks.decrypt.mockReturnValue('ghp_faketoken');
  mocks.resolveDockerfile.mockResolvedValue({
    dockerfilePath: '/tmp/prodstack-builds-test/build-1/repo/Dockerfile',
    port: 3000,
    framework: null,
  });
  mocks.mkdir.mockResolvedValue(undefined);
  mocks.rm.mockResolvedValue(undefined);
  // Every git clone/fetch/checkout "succeeds".
  mocks.spawn.mockImplementation(() => fakeGitChild(0));
});

describe('runBuild FAILURE path (real kaniko-mode orchestration)', () => {
  it('kaniko exits non-zero → build ends FAILED with "kaniko exited with code 1" and NEVER deploys', async () => {
    mocks.runKaniko.mockResolvedValue({ exitCode: 1, timedOut: false });

    await runBuild('build-1');

    // The real orchestration ran: it actually invoked our kaniko seam.
    expect(mocks.runKaniko).toHaveBeenCalledTimes(1);
    // The git-clone seam was driven for real (clone + fetch + checkout).
    expect(mocks.spawn).toHaveBeenCalled();

    const statuses = statusWrites();
    // Got past CLONING + BUILDING (proving runRealBuild ran), then FAILED.
    expect(statuses).toContain('CLONING');
    expect(statuses).toContain('BUILDING');
    expect(statuses).not.toContain('READY');
    expect(statuses).not.toContain('CANCELLED');

    // The terminal write is FAILED with the real error string from runBuild.ts.
    const data = terminalUpdate();
    expect(data.status).toBe('FAILED');
    expect(data.errorMessage).toContain('kaniko exited with code 1');

    // A failed build must NEVER reach the Azure deploy chokepoint.
    expect(mocks.updateContainerApp).not.toHaveBeenCalled();
    expect(mocks.$transaction).not.toHaveBeenCalled();
  });

  it('threads the kaniko redact set (ACR password + decrypted GitHub token, NOT usernames) into runKaniko', async () => {
    // Finding 1: the kaniko output path must redact the worker's secrets, same as
    // the git path. runRealBuild builds the redact set and passes it to runKaniko;
    // kaniko.ts applies it inside streamLines. Here we capture the runKaniko call
    // and assert the set's contents (the redaction mechanics are proven against a
    // real child in kaniko.redact.test.ts).
    mocks.runKaniko.mockResolvedValue({ exitCode: 1, timedOut: false });

    await runBuild('build-1');

    expect(mocks.runKaniko).toHaveBeenCalledTimes(1);
    const opts = mocks.runKaniko.mock.calls[0]![0] as { redactSecrets?: string[] };
    // ACR_PASSWORD (hoisted env) + the decrypted GitHub token (mocked decrypt).
    expect(opts.redactSecrets).toEqual(
      expect.arrayContaining(['acr-password', 'ghp_faketoken']),
    );
    // Usernames are NOT secrets and the ACR username equals the registry name
    // (it appears in every *.azurecr.io destination we want visible), so it must
    // never be in the redact set — redacting it would mangle legitimate output.
    expect(opts.redactSecrets).not.toContain('prodstacktest');
    // No empty strings (DOCKERHUB_TOKEN is unset in this env → filtered out).
    expect(opts.redactSecrets).not.toContain('');
  });

  it('kaniko times out → build ends FAILED with a timeout errorMessage and NEVER deploys', async () => {
    mocks.runKaniko.mockResolvedValue({ exitCode: 0, timedOut: true });

    await runBuild('build-1');

    expect(mocks.runKaniko).toHaveBeenCalledTimes(1);

    const statuses = statusWrites();
    expect(statuses).toContain('BUILDING');
    expect(statuses).not.toContain('READY');

    const data = terminalUpdate();
    expect(data.status).toBe('FAILED');
    // Real string: `build exceeded ${env.BUILD_TIMEOUT_MS}ms timeout`.
    expect(data.errorMessage).toMatch(/exceeded .*timeout/i);
    expect(data.errorMessage).toContain('600000');

    // Timeout is a failure — no deploy.
    expect(mocks.updateContainerApp).not.toHaveBeenCalled();
    expect(mocks.$transaction).not.toHaveBeenCalled();
  });
});

describe('runBuild demo-isolation backstop (docs/DEMO_MODE.md §4 layer 5)', () => {
  it('refuses a demo build before any clone/kaniko/deploy and records it FAILED', async () => {
    // The real worker must NEVER execute a demo build. Even if a demo row reached
    // runBuild (a pre-claim bug, a webhook for a demo project, a future caller),
    // it must fail closed — never clone a repo, push to ACR, or roll a real
    // Container App under a sandboxed session.
    mocks.buildFindUniqueOrThrow.mockResolvedValue(buildRow({ isDemo: true }));

    await runBuild('build-1');

    const data = terminalUpdate();
    expect(data.status).toBe('FAILED');
    expect(data.errorMessage).toMatch(/demo build/i);

    // No external side effect whatsoever.
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.runKaniko).not.toHaveBeenCalled();
    expect(mocks.updateContainerApp).not.toHaveBeenCalled();
    expect(mocks.$transaction).not.toHaveBeenCalled();
  });
});

describe('runBuild wrong-commit integrity guard', () => {
  it('FAILS the build when the cloned HEAD does not match the requested commit', async () => {
    // `--depth 1` clones the branch HEAD; if HEAD advanced and the exact commit
    // could not be fetched, the build must NOT silently ship the wrong source.
    // Drive `git rev-parse HEAD` to a sha that disagrees with build.commitSha.
    const wrongHead = 'f'.repeat(40); // disjoint from 'abc1234def5678'
    mocks.spawn.mockImplementation((_cmd: string, args: string[]) =>
      Array.isArray(args) && args.includes('rev-parse')
        ? fakeGitChild(0, wrongHead)
        : fakeGitChild(0),
    );

    await runBuild('build-1');

    // Kaniko must never run — we bailed during clone integrity verification.
    expect(mocks.runKaniko).not.toHaveBeenCalled();
    expect(mocks.updateContainerApp).not.toHaveBeenCalled();

    const data = terminalUpdate();
    expect(data.status).toBe('FAILED');
    expect(data.errorMessage).toMatch(/does not match requested commit/i);
  });

  it('proceeds normally when rev-parse confirms the requested commit', async () => {
    // build.commitSha is the short 'abc1234def5678'; a full HEAD that begins with
    // it is a match (short sha is a prefix of the resolved 40-char sha).
    const matchingHead = 'abc1234def5678' + '0'.repeat(40 - 'abc1234def5678'.length);
    mocks.spawn.mockImplementation((_cmd: string, args: string[]) =>
      Array.isArray(args) && args.includes('rev-parse')
        ? fakeGitChild(0, matchingHead)
        : fakeGitChild(0),
    );
    mocks.runKaniko.mockResolvedValue({ exitCode: 1, timedOut: false });

    await runBuild('build-1');

    // It got PAST the integrity check into the build (kaniko ran) — the guard
    // does not false-positive on a matching short sha.
    expect(mocks.runKaniko).toHaveBeenCalledTimes(1);
    const data = terminalUpdate();
    // Failed at kaniko (as configured), NOT at the integrity guard.
    expect(data.errorMessage).toContain('kaniko exited with code 1');
  });
});

describe('runBuild terminal-state safety net (stuck in-flight reconcile)', () => {
  it('force-fails the build in the finally block when the catch status write itself throws', async () => {
    // The catch writes FAILED via prisma.build.update — but if THAT write throws
    // (a transient DB error), the row would be left in an in-flight status with
    // its claim held: the KEDA `builds-pending` count never drops, the billed
    // builder stays warm, and the build is silently lost. The finally-block
    // reconcile must force it terminal via updateMany and clear the claim.
    mocks.runKaniko.mockResolvedValue({ exitCode: 1, timedOut: false });
    // Let the in-flight writes (CLONING/BUILDING) succeed, but make the terminal
    // FAILED write throw, simulating a DB blip exactly at the worst moment.
    mocks.buildUpdate.mockImplementation(
      async (arg: { data?: { status?: string } }) => {
        if (arg?.data?.status === 'FAILED') throw new Error('db blip on terminal write');
        return {};
      },
    );
    mocks.buildUpdateMany.mockResolvedValue({ count: 1 });

    // The catch's failed write re-throws past the finally; the worker backstop
    // would log it — here we just assert it rejected AND that the net engaged.
    await expect(runBuild('build-1')).rejects.toThrow(/db blip/);

    expect(mocks.buildUpdateMany).toHaveBeenCalledTimes(1);
    const arg = mocks.buildUpdateMany.mock.calls[0]![0] as {
      where: { id: string; status: { in: string[] } };
      data: { status: string; claimedAt: null; claimedBy: null };
    };
    expect(arg.where.id).toBe('build-1');
    expect(arg.where.status.in).toContain('BUILDING');
    expect(arg.data.status).toBe('FAILED');
    // Clears the claim so the row can never look "claimed by a dead worker".
    expect(arg.data.claimedAt).toBeNull();
    expect(arg.data.claimedBy).toBeNull();
  });
});
