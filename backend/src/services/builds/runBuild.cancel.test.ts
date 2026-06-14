// Worker-side cancellation (M5 #8). Exercises runBuild in stub mode so the
// AbortController wiring + terminal-state classification (CANCELLED vs FAILED)
// are covered without a docker daemon. The HTTP cancel handler is covered
// separately in routes/builds.cancel.test.ts.
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
process.env.BUILD_RUNNER_MODE = 'stub';
process.env.BUILD_WORK_DIR = '/tmp/prodstack-builds-test';

import { beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('../azure/index.js', () => ({ updateContainerApp: mocks.updateContainerApp }));
vi.mock('../projectEnv.js', () => ({ loadDecryptedEnvVars: mocks.loadDecryptedEnvVars }));

const { runBuild } = await import('./runBuild.js');

function stubBuildRow(over: Record<string, unknown> = {}) {
  return {
    id: 'build-1',
    projectId: 'project-1',
    commitSha: 'abc1234def5678',
    branch: 'main',
    startedAt: null,
    project: {
      id: 'project-1',
      containerAppName: 'octocat-app',
      githubRepoFullName: 'octocat/app',
      user: {},
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

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.buildFindUniqueOrThrow.mockResolvedValue(stubBuildRow());
  mocks.buildUpdate.mockResolvedValue({});
  // The finally-block terminal reconcile is a no-op here (the build reaches a
  // terminal state on its own) — it must find 0 non-terminal rows to flip.
  mocks.buildUpdateMany.mockResolvedValue({ count: 0 });
  mocks.logLineCreate.mockResolvedValue({});
  mocks.loadDecryptedEnvVars.mockResolvedValue([]);
});

describe('runBuild cancellation (stub mode)', () => {
  it('records CANCELLED (never FAILED) and never deploys when cancelRequested is set before work', async () => {
    // The immediate pre-work check sees the flag and aborts before the sleeps.
    mocks.buildFindUnique.mockResolvedValue({ cancelRequested: true });

    await runBuild('build-1');

    const statuses = statusWrites();
    expect(statuses).toContain('CANCELLED');
    expect(statuses).not.toContain('FAILED');
    expect(statuses).not.toContain('READY');
    // A cancel before the deploy must not roll the Container App.
    expect(mocks.updateContainerApp).not.toHaveBeenCalled();
    expect(mocks.$transaction).not.toHaveBeenCalled();
  });

  it('records FAILED (never CANCELLED) for a genuine error when not aborting', async () => {
    // Not cancelled; force an error at the CLONING transition so we never reach
    // a sleep. The catch must classify this as FAILED, not CANCELLED.
    mocks.buildFindUnique.mockResolvedValue({ cancelRequested: false });
    mocks.buildUpdate.mockImplementation(
      async ({ data }: { data: { status?: string } }) => {
        if (data.status === 'CLONING') throw new Error('db boom');
        return {};
      },
    );

    await runBuild('build-1');

    const statuses = statusWrites();
    expect(statuses).toContain('FAILED');
    expect(statuses).not.toContain('CANCELLED');
    expect(mocks.updateContainerApp).not.toHaveBeenCalled();
  });
});
