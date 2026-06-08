// Demo orchestrator (docs/DEMO_MODE.md §6.2). The critical fail-closed suite:
//   - a demo build is created PRE-CLAIMED (claimedAt set, claimedBy='demo-driver',
//     status QUEUED, isDemo true) so the Kaniko worker is structurally blind to it;
//   - every function refuses to act for a non-demo user;
//   - the orchestrator never imports/calls any Azure SDK or GitHub mutation.
process.env.NODE_ENV = 'test';
process.env.WEB_ORIGIN = 'http://localhost:5173';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.JWT_SECRET = 'test-jwt-secret-test-jwt-secret-test-jwt-secret';
process.env.COOKIE_SECRET = 'test-cookie-secret-test-cookie-secret-test-cookie';
process.env.DATA_ENC_KEY = Buffer.alloc(32, 9).toString('base64');
process.env.GITHUB_OAUTH_CLIENT_ID = 'test-client-id';
process.env.GITHUB_OAUTH_CLIENT_SECRET = 'test-client-secret';
process.env.GITHUB_OAUTH_CALLBACK_URL = 'http://localhost:3000/api/auth/github/callback';
process.env.AZURE_STUB = 'true';
process.env.LOG_LEVEL = 'silent';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userFindUniqueOrThrow: vi.fn(),
  projectFindMany: vi.fn(),
  projectFindUnique: vi.fn(),
  projectCreate: vi.fn(),
  envVarCreate: vi.fn(),
  buildCreate: vi.fn(),
  buildFindFirst: vi.fn(),
  logLineCreateMany: vi.fn(),
  deploymentCreate: vi.fn(),
  deploymentFindFirst: vi.fn(),
  deploymentUpdateMany: vi.fn(),
  $transaction: vi.fn(),
  startDemoReplay: vi.fn(),
}));

// Interactive-transaction client exposing the same mock fns.
const txClient = {
  deployment: { updateMany: mocks.deploymentUpdateMany, create: mocks.deploymentCreate },
};

vi.mock('../../db.js', () => ({
  prisma: {
    user: { findUnique: mocks.userFindUnique, findUniqueOrThrow: mocks.userFindUniqueOrThrow },
    project: {
      findMany: mocks.projectFindMany,
      findUnique: mocks.projectFindUnique,
      create: mocks.projectCreate,
    },
    envVar: { create: mocks.envVarCreate },
    build: { create: mocks.buildCreate, findFirst: mocks.buildFindFirst },
    logLine: { createMany: mocks.logLineCreateMany },
    deployment: {
      create: mocks.deploymentCreate,
      findFirst: mocks.deploymentFindFirst,
      updateMany: mocks.deploymentUpdateMany,
    },
    $transaction: mocks.$transaction,
  },
}));

// Stub the driver so the orchestrator's fire-and-forget launch does no real work.
vi.mock('./demoBuildDriver.js', () => ({
  startDemoReplay: mocks.startDemoReplay,
}));

const { createDemoProject, startDemoBuild, seedDemoWorkspace, rollbackDemoDeployment } =
  await import('./demoOrchestrator.js');
const { SEED_PROJECTS } = await import('./fixtures/seed-workspace.js');

const DEMO_USER = { id: 'demo-1', githubLogin: 'demo-abc123' };

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.userFindUnique.mockResolvedValue({ isDemo: true });
  mocks.userFindUniqueOrThrow.mockResolvedValue({ githubLogin: DEMO_USER.githubLogin });
  mocks.projectFindMany.mockResolvedValue([]);
  mocks.projectCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'proj-new',
    slug: data.slug,
    containerAppName: data.containerAppName,
    ...data,
  }));
  mocks.projectFindUnique.mockResolvedValue({
    user: { isDemo: true, githubLogin: DEMO_USER.githubLogin },
  });
  mocks.buildCreate.mockResolvedValue({ id: 'build-new' });
  mocks.buildFindFirst.mockResolvedValue(null);
  mocks.envVarCreate.mockResolvedValue({});
  mocks.logLineCreateMany.mockResolvedValue({});
  mocks.deploymentCreate.mockResolvedValue({ id: 'dep-new', active: true, build: {} });
  mocks.deploymentUpdateMany.mockResolvedValue({ count: 1 });
  mocks.$transaction.mockImplementation(async (arg: unknown) =>
    typeof arg === 'function'
      ? (arg as (tx: typeof txClient) => Promise<unknown>)(txClient)
      : Promise.all(arg as Promise<unknown>[]),
  );
});

describe('createDemoProject', () => {
  it('creates the project DB-only and does NOT start a build (matches the real create)', async () => {
    const result = await createDemoProject(DEMO_USER, {
      name: 'My Cool App',
      repoUrl: 'https://github.com/someone/cool-app',
    });

    expect(result).toEqual({ projectId: 'proj-new' });

    // The DB-only create has no webhook id; nothing external was registered.
    const projectData = mocks.projectCreate.mock.calls[0]![0].data;
    expect(projectData.webhookId).toBeNull();
    expect(projectData.slug).toBe('my-cool-app');

    // Like a real create, NO build is started on create — the first build is
    // kicked explicitly via "Trigger build" (the /rebuild demo branch →
    // startDemoBuild, covered by its own tests below). So neither a Build row
    // nor the replay driver is touched here.
    expect(mocks.buildCreate).not.toHaveBeenCalled();
    expect(mocks.startDemoReplay).not.toHaveBeenCalled();
  });

  it('dedupes the slug among the demo user existing live projects', async () => {
    mocks.projectFindMany.mockResolvedValue([{ slug: 'my-cool-app' }]);
    await createDemoProject(DEMO_USER, {
      name: 'My Cool App',
      repoUrl: 'https://github.com/x/y',
    });
    expect(mocks.projectCreate.mock.calls[0]![0].data.slug).toBe('my-cool-app-2');
  });

  it('throws for a non-demo user and never creates a build', async () => {
    mocks.userFindUnique.mockResolvedValue({ isDemo: false });
    await expect(
      createDemoProject(DEMO_USER, { name: 'x', repoUrl: 'https://github.com/a/b' }),
    ).rejects.toThrow(/non-demo user/);
    expect(mocks.projectCreate).not.toHaveBeenCalled();
    expect(mocks.buildCreate).not.toHaveBeenCalled();
  });
});

describe('startDemoBuild', () => {
  it('inserts a pre-claimed build and launches the replay', async () => {
    const { buildId } = await startDemoBuild({
      id: 'proj-1',
      branch: 'main',
      githubRepoFullName: 'a/b',
    });
    expect(buildId).toBe('build-new');
    const data = mocks.buildCreate.mock.calls[0]![0].data;
    expect(data).toMatchObject({
      projectId: 'proj-1',
      status: 'QUEUED',
      isDemo: true,
      claimedBy: 'demo-driver',
    });
    expect(data.claimedAt).toBeInstanceOf(Date);
    expect(mocks.startDemoReplay).toHaveBeenCalledWith('build-new');
  });

  it('throws when the project owner is not a demo user', async () => {
    mocks.projectFindUnique.mockResolvedValue({ user: { isDemo: false, githubLogin: 'real' } });
    await expect(
      startDemoBuild({ id: 'proj-1', branch: 'main', githubRepoFullName: 'a/b' }),
    ).rejects.toThrow(/non-demo user/);
    expect(mocks.buildCreate).not.toHaveBeenCalled();
    expect(mocks.startDemoReplay).not.toHaveBeenCalled();
  });
});

describe('seedDemoWorkspace', () => {
  it('inserts the expected projects, builds, and an active deployment per seeded project', async () => {
    await seedDemoWorkspace('demo-1');

    // Counts derive from the fixture so this test tracks SEED_PROJECTS instead of
    // a magic number that silently rots when the fixture changes.
    const expectedProjects = SEED_PROJECTS.length;
    const expectedBuilds = SEED_PROJECTS.reduce((n, p) => n + p.builds.length, 0);
    const expectedDeployments = SEED_PROJECTS.reduce(
      (n, p) => n + p.builds.filter((b) => b.deploy).length,
      0,
    );

    expect(mocks.projectCreate).toHaveBeenCalledTimes(expectedProjects);

    // Every seeded build carries isDemo=true.
    expect(mocks.buildCreate).toHaveBeenCalledTimes(expectedBuilds);
    for (const call of mocks.buildCreate.mock.calls) {
      expect(call[0].data.isDemo).toBe(true);
    }

    // Each `deploy: true` build gets exactly one active deployment.
    expect(mocks.deploymentCreate).toHaveBeenCalledTimes(expectedDeployments);
    for (const call of mocks.deploymentCreate.mock.calls) {
      expect(call[0].data.active).toBe(true);
    }

    // Sample log lines attached (one createMany per project, for its newest build).
    expect(mocks.logLineCreateMany).toHaveBeenCalledTimes(expectedProjects);
  });

  it('throws for a non-demo user', async () => {
    mocks.userFindUnique.mockResolvedValue({ isDemo: false });
    await expect(seedDemoWorkspace('demo-1')).rejects.toThrow(/non-demo user/);
    expect(mocks.projectCreate).not.toHaveBeenCalled();
  });
});

describe('rollbackDemoDeployment', () => {
  const RB = { projectId: 'p1', deploymentId: 'd-old', userId: 'demo-1' };
  const readyTarget = {
    id: 'd-old',
    projectId: 'p1',
    buildId: 'b-old',
    revisionName: 'demo-app--demo-old',
    active: false,
    build: { id: 'b-old', status: 'READY', imageTag: 'demo-old' },
  };

  it('re-points the active deployment DB-only (no Azure) and never deactivates via updateContainerApp', async () => {
    mocks.deploymentFindFirst.mockResolvedValue(readyTarget);
    const result = await rollbackDemoDeployment(RB);

    // Deactivated the prior active row + created a new active rolledBack row.
    expect(mocks.deploymentUpdateMany).toHaveBeenCalledWith({
      where: { projectId: 'p1', active: true },
      data: { active: false },
    });
    const created = mocks.deploymentCreate.mock.calls.at(-1)![0];
    expect(created.data).toMatchObject({ buildId: 'b-old', active: true, rolledBack: true });
    expect(result).toMatchObject({ id: 'dep-new', active: true });
  });

  it('throws for a non-demo user before touching deployments', async () => {
    mocks.userFindUnique.mockResolvedValue({ isDemo: false });
    await expect(rollbackDemoDeployment(RB)).rejects.toThrow(/non-demo user/);
    expect(mocks.deploymentFindFirst).not.toHaveBeenCalled();
  });

  it('404s an unknown/foreign deployment', async () => {
    mocks.deploymentFindFirst.mockResolvedValue(null);
    await expect(rollbackDemoDeployment(RB)).rejects.toMatchObject({ status: 404 });
  });

  it('409s when the target build did not finish successfully', async () => {
    mocks.deploymentFindFirst.mockResolvedValue({
      ...readyTarget,
      build: { id: 'b-old', status: 'FAILED', imageTag: 'demo-old' },
    });
    await expect(rollbackDemoDeployment(RB)).rejects.toMatchObject({
      status: 409,
      code: 'BUILD_NOT_DEPLOYABLE',
    });
  });

  it('409s when a build is in flight for the project', async () => {
    mocks.deploymentFindFirst.mockResolvedValue(readyTarget);
    mocks.buildFindFirst.mockResolvedValue({ id: 'b-running' });
    await expect(rollbackDemoDeployment(RB)).rejects.toMatchObject({
      status: 409,
      code: 'BUILD_IN_PROGRESS',
    });
    expect(mocks.deploymentCreate).not.toHaveBeenCalled();
  });
});
