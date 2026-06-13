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
// The build itself — our controlled seam. Returns failing KanikoResults.
vi.mock('./kaniko.js', () => ({ runKaniko: mocks.runKaniko }));

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

/** A fake `git` child process that immediately closes with the given exit code. */
function fakeGitChild(exitCode = 0): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void } {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  // Emit `close` on the next tick so the listeners registered synchronously by
  // spawnLogged are attached before we fire.
  setImmediate(() => child.emit('close', exitCode));
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
