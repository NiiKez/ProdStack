process.env.NODE_ENV = 'test';
process.env.DATA_ENC_KEY ??= Buffer.alloc(32, 9).toString('base64');
process.env.JWT_SECRET ??= 'x'.repeat(40);
process.env.COOKIE_SECRET ??= 'y'.repeat(40);
process.env.WEB_ORIGIN ??= 'http://localhost:5173';
process.env.GITHUB_OAUTH_CLIENT_ID ??= 'cid';
process.env.GITHUB_OAUTH_CLIENT_SECRET ??= 'csecret';
process.env.GITHUB_OAUTH_CALLBACK_URL ??= 'http://localhost:3000/api/auth/github/callback';
process.env.DATABASE_URL ??= 'postgresql://test/test';
process.env.AZURE_STUB ??= 'true';
process.env.LOG_LEVEL ??= 'silent';

import { Prisma } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { encrypt } from '../lib/crypto.js';

interface ProjectRecord {
  id: string;
  userId: string;
  name: string;
  slug: string;
  githubRepoFullName: string;
  githubRepoId: number;
  branch: string;
  webhookId: number | null;
  containerAppName: string;
  liveUrl: string | null;
  frameworkHint: string | null;
  isDemo: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

const tokenField = encrypt('ghp_dummy_token');

const state = vi.hoisted(() => ({
  stubAuth: true,
  isDemo: false,
  projects: [] as Array<{
    id: string;
    userId: string;
    name: string;
    slug: string;
    githubRepoFullName: string;
    githubRepoId: number;
    branch: string;
    webhookId: number | null;
    containerAppName: string;
    liveUrl: string | null;
    frameworkHint: string | null;
    isDemo: boolean;
    createdAt: Date;
    updatedAt: Date;
    deletedAt: Date | null;
  }>,
}));

const fakeUser = {
  id: 'u1',
  githubLogin: 'octocat',
  email: 'octo@example.com',
  avatarUrl: null,
};

const userRow = {
  id: fakeUser.id,
  githubLogin: fakeUser.githubLogin,
  email: fakeUser.email,
  avatarUrl: fakeUser.avatarUrl,
  githubTokenCiphertext: tokenField.ciphertext,
  githubTokenIv: tokenField.iv,
  githubTokenAuthTag: tokenField.authTag,
  githubTokenKeyVersion: tokenField.keyVersion,
  // Real (non-demo) user — the create handler denormalizes this onto the new
  // project (feeds the project_repo_live_real partial unique index).
  isDemo: false,
};

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  projectFindMany: vi.fn(),
  projectFindFirst: vi.fn(),
  projectFindUniqueOrThrow: vi.fn(),
  projectCreate: vi.fn(),
  projectUpdate: vi.fn(),
  projectCount: vi.fn(),
  buildFindFirst: vi.fn(),
  queryRaw: vi.fn(),
  octokitForUser: vi.fn(),
  octokitRequest: vi.fn(),
  createContainerApp: vi.fn(),
  updateContainerApp: vi.fn(),
  deleteContainerApp: vi.fn(),
  fetchBranchHeadCommit: vi.fn(),
  createDemoProject: vi.fn(),
  startDemoBuild: vi.fn(),
  rollbackDemoDeployment: vi.fn(),
  transaction: vi.fn(),
  loadDecryptedEnvVars: vi.fn(),
  loadEnvVarMeta: vi.fn(),
  redeployWithCurrentEnv: vi.fn(),
  getAppMetrics: vi.fn(),
  queryRuntimeLogs: vi.fn(),
}));

vi.mock('../db.js', () => ({
  prisma: {
    user: { findUnique: mocks.userFindUnique },
    project: {
      findMany: mocks.projectFindMany,
      findFirst: mocks.projectFindFirst,
      findUniqueOrThrow: mocks.projectFindUniqueOrThrow,
      create: mocks.projectCreate,
      update: mocks.projectUpdate,
      count: mocks.projectCount,
    },
    build: { findFirst: mocks.buildFindFirst },
    $queryRaw: mocks.queryRaw,
    $transaction: mocks.transaction,
  },
}));

// projectEnv + deploy are mocked so the PATCH env-var path can be exercised
// without a real DB tx / Azure redeploy. `IN_FLIGHT_BUILD_STATUSES` and
// `rollbackToDeployment` keep their real exports (the route imports them).
vi.mock('../services/projectEnv.js', () => ({
  loadDecryptedEnvVars: mocks.loadDecryptedEnvVars,
  loadEnvVarMeta: mocks.loadEnvVarMeta,
}));

vi.mock('../services/deploy.js', async () => {
  const actual = (await vi.importActual('../services/deploy.js')) as Record<string, unknown>;
  return {
    ...actual,
    redeployWithCurrentEnv: mocks.redeployWithCurrentEnv,
  };
});

// The demo orchestrator owns all demo write behavior; mock it so the demo
// branches in the route can be asserted to dispatch to it (and the fail-closed
// suite can assert the real GitHub/Azure mocks were NOT called).
vi.mock('../services/demo/demoOrchestrator.js', () => ({
  createDemoProject: mocks.createDemoProject,
  startDemoBuild: mocks.startDemoBuild,
  rollbackDemoDeployment: mocks.rollbackDemoDeployment,
}));

// Azure metrics/logs: keep the real `stub*` generators (the demo branch uses
// them) but spy on the real `getAppMetrics`/`queryRuntimeLogs` so a demo request
// can assert it NEVER reaches the real Azure-Monitor/Log-Analytics path.
vi.mock('../services/azure/metrics.js', async () => {
  const actual = (await vi.importActual('../services/azure/metrics.js')) as Record<string, unknown>;
  return { ...actual, getAppMetrics: mocks.getAppMetrics };
});
vi.mock('../services/azure/logs.js', async () => {
  const actual = (await vi.importActual('../services/azure/logs.js')) as Record<string, unknown>;
  return { ...actual, queryRuntimeLogs: mocks.queryRuntimeLogs };
});

// Re-export the real `GithubWebhookError` class so `instanceof` checks in the
// route resolve to the same constructor as the helpers throw from. The
// helpers themselves are thin wrappers around `octokit.request`, so letting
// the real implementations run keeps the route's branching behavior under
// test rather than the mock's.
vi.mock('../services/github.js', async () => {
  const actual = (await vi.importActual('../services/github.js')) as Record<string, unknown>;
  return {
    ...actual,
    octokitForUser: mocks.octokitForUser,
    // Overridden so the fail-closed suite can assert the demo rebuild path
    // never reaches GitHub for the branch-head commit.
    fetchBranchHeadCommit: mocks.fetchBranchHeadCommit,
  };
});

vi.mock('../services/azure/index.js', () => ({
  createContainerApp: mocks.createContainerApp,
  updateContainerApp: mocks.updateContainerApp,
  deleteContainerApp: mocks.deleteContainerApp,
}));

vi.mock('../middleware/requireAuth.js', () => ({
  requireAuth: (
    req: { user?: unknown },
    res: { status: (n: number) => { json: (b: unknown) => void } },
    next: () => void,
  ) => {
    if (state.stubAuth) {
      req.user = {
        id: 'u1',
        githubLogin: 'octocat',
        email: 'octo@example.com',
        avatarUrl: null,
        isDemo: state.isDemo,
      };
      next();
      return;
    }
    res.status(401).json({ error: 'UNAUTHENTICATED' });
  },
}));

vi.mock('./auth.js', async () => {
  const express = await import('express');
  return { default: express.Router() };
});

const { createApp } = await import('../app.js');
const supertest = (await import('supertest')).default;

beforeEach(() => {
  state.stubAuth = true;
  state.isDemo = false;
  state.projects.length = 0;

  mocks.userFindUnique.mockReset();
  mocks.projectFindMany.mockReset();
  mocks.projectFindFirst.mockReset();
  mocks.projectFindUniqueOrThrow.mockReset();
  mocks.projectCreate.mockReset();
  mocks.projectUpdate.mockReset();
  mocks.projectCount.mockReset();
  mocks.buildFindFirst.mockReset();
  mocks.queryRaw.mockReset();
  mocks.octokitForUser.mockReset();
  mocks.octokitRequest.mockReset();
  mocks.createContainerApp.mockReset();
  mocks.updateContainerApp.mockReset();
  mocks.deleteContainerApp.mockReset();
  mocks.fetchBranchHeadCommit.mockReset();
  mocks.createDemoProject.mockReset();
  mocks.startDemoBuild.mockReset();
  mocks.rollbackDemoDeployment.mockReset();
  mocks.transaction.mockReset();
  mocks.loadDecryptedEnvVars.mockReset();
  mocks.loadEnvVarMeta.mockReset();
  mocks.redeployWithCurrentEnv.mockReset();
  mocks.getAppMetrics.mockReset();
  mocks.queryRuntimeLogs.mockReset();

  mocks.userFindUnique.mockResolvedValue(userRow);
  mocks.projectFindMany.mockImplementation(
    async (args?: {
      select?: { slug?: boolean };
      where?: { deletedAt?: null | Date };
    }) => {
      const filterLive = args?.where?.deletedAt === null;
      const rows = filterLive
        ? state.projects.filter((p) => p.deletedAt === null)
        : state.projects;
      if (args !== undefined && args.select !== undefined && args.select.slug === true) {
        return rows.map((p) => ({ slug: p.slug }));
      }
      return rows.map((p) => ({ ...p, builds: [], deployments: [] }));
    },
  );
  mocks.projectFindFirst.mockResolvedValue(null);
  mocks.projectCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    // Model the DB's *partial* unique index `project_user_slug_live`
    // (UNIQUE (userId, slug) WHERE deletedAt IS NULL): a collision only happens
    // against a *live* row. Soft-deleted tombstones don't participate — this is
    // exactly what lets a project be recreated with the same slug after delete.
    const liveCollision = state.projects.some(
      (p) =>
        p.deletedAt === null &&
        p.userId === (data.userId as string) &&
        p.slug === (data.slug as string),
    );
    if (liveCollision) {
      throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      });
    }
    const project: ProjectRecord = {
      id: `p${state.projects.length + 1}`,
      userId: data.userId as string,
      name: data.name as string,
      slug: data.slug as string,
      githubRepoFullName: data.githubRepoFullName as string,
      githubRepoId: data.githubRepoId as number,
      branch: data.branch as string,
      webhookId: (data.webhookId as number | null) ?? null,
      containerAppName: data.containerAppName as string,
      liveUrl: (data.liveUrl as string | null) ?? null,
      frameworkHint: null,
      isDemo: (data.isDemo as boolean | undefined) ?? false,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    };
    state.projects.push(project);
    return { ...project, builds: [], deployments: [] };
  });
  mocks.projectCount.mockResolvedValue(0);

  // Default: GET repo lookup returns the fixture; webhook create returns id=99;
  // webhook delete resolves. Tests override per case.
  mocks.octokitRequest.mockImplementation(async (route: string) => {
    if (route.startsWith('GET /repos/')) {
      return { data: { id: 12345, default_branch: 'main' } };
    }
    if (route === 'POST /repos/{owner}/{repo}/hooks') {
      return { data: { id: 99 } };
    }
    if (route === 'DELETE /repos/{owner}/{repo}/hooks/{hook_id}') {
      return { data: {} };
    }
    return { data: {} };
  });
  mocks.octokitForUser.mockReturnValue({ request: mocks.octokitRequest });

  mocks.createContainerApp.mockImplementation(async ({ name }: { name: string }) => ({
    name,
    liveUrl: `https://${name}.example.com`,
  }));
  mocks.deleteContainerApp.mockResolvedValue(undefined);

  // No in-flight build by default (rebuild path's in-flight guard).
  mocks.buildFindFirst.mockResolvedValue(null);

  // Demo orchestrator: create returns ids; the route re-fetches via
  // findUniqueOrThrow, so seed a matching project row to reshape into a 201.
  mocks.createDemoProject.mockImplementation(async () => ({
    projectId: 'demo-p1',
  }));
  mocks.startDemoBuild.mockResolvedValue({ buildId: 'demo-b1' });
  mocks.rollbackDemoDeployment.mockResolvedValue({
    id: 'demo-dep2',
    revisionName: 'octocat-demo-app--demo-old',
    active: true,
    rolledBack: true,
    createdAt: new Date(),
    build: {
      id: 'demo-b0',
      status: 'READY',
      commitSha: 'a1b2c3d',
      commitMessage: 'demo deploy',
      commitAuthor: 'demo-abc',
      branch: 'main',
      imageTag: 'demo-a1b2c3d',
    },
  });

  // Real Azure metrics/logs paths must never run for a demo request; default to
  // a sentinel resolve so the demo tests' `.not.toHaveBeenCalled()` is the gate.
  mocks.getAppMetrics.mockResolvedValue({ available: false, series: [] });
  mocks.queryRuntimeLogs.mockResolvedValue({ available: false, lines: [] });

  // PATCH env-var path: no existing vars; the tx callback runs against a fake
  // `tx` and returns the refreshed project; masked meta echoed back.
  mocks.loadDecryptedEnvVars.mockResolvedValue([]);
  mocks.loadEnvVarMeta.mockResolvedValue([]);
  mocks.redeployWithCurrentEnv.mockResolvedValue({ redeployed: true });
  mocks.transaction.mockImplementation(
    async (cb: (tx: unknown) => Promise<unknown>) => {
      const refreshed = {
        id: 'demo-p1',
        name: 'Demo App',
        slug: 'demo-app',
        githubRepoFullName: 'prodstack-demo/express-api',
        githubRepoId: 4242,
        branch: 'main',
        webhookId: null,
        containerAppName: 'octocat-demo-app',
        liveUrl: null,
        frameworkHint: null,
        autoDeploy: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        builds: [],
        deployments: [],
      };
      const tx = {
        project: {
          update: vi.fn().mockResolvedValue(refreshed),
          findFirstOrThrow: vi.fn().mockResolvedValue(refreshed),
        },
        envVar: {
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
          upsert: vi.fn().mockResolvedValue({}),
        },
      };
      return cb(tx);
    },
  );

  mocks.projectFindUniqueOrThrow.mockResolvedValue({
    id: 'demo-p1',
    userId: 'u1',
    name: 'Demo App',
    slug: 'demo-app',
    githubRepoFullName: 'prodstack-demo/express-api',
    githubRepoId: 4242,
    branch: 'main',
    webhookId: null,
    containerAppName: 'octocat-demo-app',
    liveUrl: null,
    frameworkHint: null,
    autoDeploy: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    builds: [],
    deployments: [],
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/projects', () => {
  it('rejects requests missing X-Requested-With with 403', async () => {
    const app = createApp();
    const res = await supertest(app)
      .post('/api/projects')
      .send({ repoUrl: 'https://github.com/octocat/hello', name: 'Hello' });
    expect(res.status).toBe(403);
  });

  it('rejects unauthenticated requests with 401', async () => {
    state.stubAuth = false;
    const app = createApp();
    const res = await supertest(app)
      .post('/api/projects')
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({ repoUrl: 'https://github.com/octocat/hello', name: 'Hello' });
    expect(res.status).toBe(401);
  });

  it('creates a project on the happy path and returns 201', async () => {
    const app = createApp();
    const res = await supertest(app)
      .post('/api/projects')
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({ repoUrl: 'https://github.com/octocat/hello', name: 'Hello' });
    expect(res.status).toBe(201);
    expect(res.body.slug).toBe('hello');
    expect(res.body.githubRepoFullName).toBe('octocat/hello');
    expect(res.body.githubRepoId).toBe(12345);
    expect(res.body.containerAppName).toBe('octocat-hello');
    expect(res.body.liveUrl).toBe('https://octocat-hello.example.com');
    expect(res.body).not.toHaveProperty('webhookSecretCiphertext');
    expect(mocks.createContainerApp).toHaveBeenCalledWith({ name: 'octocat-hello' });
  });

  it('persists isDemo=false for a real authenticated user', async () => {
    const app = createApp();
    const res = await supertest(app)
      .post('/api/projects')
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({ repoUrl: 'https://github.com/octocat/hello', name: 'Hello' });
    expect(res.status).toBe(201);
    // The create handler denormalizes the owning user's isDemo onto the project
    // (false for a real user) — feeds the project_repo_live_real unique index.
    const createCall = mocks.projectCreate.mock.calls[0]![0] as { data: { isDemo?: unknown } };
    expect(createCall.data.isDemo).toBe(false);
    expect(state.projects[0]!.isDemo).toBe(false);
  });

  it('rejects connecting a repo already backed by a live non-demo project with 409', async () => {
    // Webhook routing resolves a delivery to its project by githubRepoId, so two
    // live non-demo projects on the same repo would make HMAC verification
    // non-deterministic. The create handler pre-checks for an existing live
    // non-demo project on that repo and returns a friendly 409 (the DB partial
    // unique index project_repo_live_real is the hard backstop). The GET repo
    // lookup returns id 12345; simulate one already connected.
    mocks.projectFindFirst.mockResolvedValueOnce({ id: 'p-existing' });
    const app = createApp();
    const res = await supertest(app)
      .post('/api/projects')
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({ repoUrl: 'https://github.com/octocat/hello', name: 'Hello' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('REPO_ALREADY_CONNECTED');
    // No project/container app is created when the repo is already connected.
    expect(mocks.projectCreate).not.toHaveBeenCalled();
    expect(mocks.createContainerApp).not.toHaveBeenCalled();
  });

  it('dedupes the slug on a second create with the same name', async () => {
    const app = createApp();
    await supertest(app)
      .post('/api/projects')
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({ repoUrl: 'https://github.com/octocat/hello', name: 'Hello' });
    const res = await supertest(app)
      .post('/api/projects')
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({ repoUrl: 'https://github.com/octocat/hello', name: 'Hello' });
    expect(res.status).toBe(201);
    expect(res.body.slug).toBe('hello-2');
  });

  it('recreates a project with the same slug + app name after soft-delete', async () => {
    // Regression: a soft-deleted row used to keep its (userId, slug) in a plain
    // UNIQUE index, so recreating after delete collided (P2002 -> 500) and the
    // single retry re-picked the same slug. The partial unique index — modeled
    // by the projectCreate mock above — makes the tombstone stop participating.
    const app = createApp();
    await supertest(app)
      .post('/api/projects')
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({ repoUrl: 'https://github.com/octocat/hello', name: 'Hello' });
    // Simulate the user soft-deleting the first project.
    state.projects[0]!.deletedAt = new Date();
    const res = await supertest(app)
      .post('/api/projects')
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({ repoUrl: 'https://github.com/octocat/hello', name: 'Hello' });
    expect(res.status).toBe(201);
    expect(res.body.slug).toBe('hello');
    // The clean slug is fully reclaimed — same container app name as the original.
    expect(res.body.containerAppName).toBe('octocat-hello');
  });

  it('surfaces a live-slug collision that escapes dedup as 409, not 500', async () => {
    // The create flow's dedup normally avoids live collisions, but if a P2002 on
    // (userId, slug) ever reaches the error middleware it must be a clean 409.
    // Force it: seed a live "hello" but hide it from the dedup's slug lookup.
    state.projects.push({
      id: 'p-pre',
      userId: userRow.id,
      name: 'Hello',
      slug: 'hello',
      githubRepoFullName: 'octocat/hello',
      githubRepoId: 12345,
      branch: 'main',
      webhookId: 1,
      containerAppName: 'octocat-hello',
      liveUrl: null,
      frameworkHint: null,
      isDemo: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    });
    // Dedup sees no live slugs on *both* the initial attempt and the retry, so
    // both pick "hello" and both hit P2002 — the retry can't mask it as hello-2.
    mocks.projectFindMany.mockResolvedValue([]);
    const app = createApp();
    const res = await supertest(app)
      .post('/api/projects')
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({ repoUrl: 'https://github.com/octocat/hello', name: 'Hello' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('CONFLICT');
  });

  it('registers a push webhook and persists the returned webhookId', async () => {
    const app = createApp();
    const res = await supertest(app)
      .post('/api/projects')
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({ repoUrl: 'https://github.com/octocat/hello', name: 'Hello' });
    expect(res.status).toBe(201);
    expect(res.body.webhookId).toBe(99);

    const hookCall = mocks.octokitRequest.mock.calls.find(
      (c) => c[0] === 'POST /repos/{owner}/{repo}/hooks',
    );
    expect(hookCall).toBeDefined();
    const args = hookCall![1] as {
      owner: string;
      repo: string;
      name: string;
      active: boolean;
      events: string[];
      config: { url: string; content_type: string; secret: string };
    };
    expect(args.owner).toBe('octocat');
    expect(args.repo).toBe('hello');
    expect(args.name).toBe('web');
    expect(args.active).toBe(true);
    // Preview/PR environments: new hooks subscribe to pull_request too.
    expect(args.events).toEqual(['push', 'pull_request']);
    expect(args.config.content_type).toBe('json');
    // PUBLIC_API_URL defaults to http://localhost:3000; webhook path is fixed.
    expect(args.config.url).toBe('http://localhost:3000/api/webhooks/github');
    // randomBytes(32).toString('base64') → 44 chars.
    expect(args.config.secret).toHaveLength(44);

    expect(mocks.projectCreate).toHaveBeenCalledTimes(1);
    const createArgs = mocks.projectCreate.mock.calls[0]![0] as {
      data: { webhookId: number | null };
    };
    expect(createArgs.data.webhookId).toBe(99);
  });

  it('rolls back the container app and returns 403 on hook 403', async () => {
    mocks.octokitRequest.mockImplementation(async (route: string) => {
      if (route.startsWith('GET /repos/')) {
        return { data: { id: 12345, default_branch: 'main' } };
      }
      if (route === 'POST /repos/{owner}/{repo}/hooks') {
        const err: Error & { status?: number; response?: { data: { message: string } } } =
          new Error('Forbidden');
        err.status = 403;
        err.response = { data: { message: 'Resource not accessible by integration' } };
        throw err;
      }
      return { data: {} };
    });

    const app = createApp();
    const res = await supertest(app)
      .post('/api/projects')
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({ repoUrl: 'https://github.com/octocat/hello', name: 'Hello' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('WEBHOOK_PERMISSION_DENIED');
    expect(mocks.deleteContainerApp).toHaveBeenCalledWith('octocat-hello');
    expect(mocks.projectCreate).not.toHaveBeenCalled();
  });

  it('continues with webhookId=null on 422 "Hook already exists"', async () => {
    mocks.octokitRequest.mockImplementation(async (route: string) => {
      if (route.startsWith('GET /repos/')) {
        return { data: { id: 12345, default_branch: 'main' } };
      }
      if (route === 'POST /repos/{owner}/{repo}/hooks') {
        const err: Error & { status?: number; response?: { data: { message: string } } } =
          new Error('Unprocessable Entity');
        err.status = 422;
        err.response = { data: { message: 'Validation Failed: Hook already exists on this repository' } };
        throw err;
      }
      return { data: {} };
    });

    const app = createApp();
    const res = await supertest(app)
      .post('/api/projects')
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({ repoUrl: 'https://github.com/octocat/hello', name: 'Hello' });
    expect(res.status).toBe(201);
    expect(res.body.webhookId).toBeNull();
    expect(mocks.deleteContainerApp).not.toHaveBeenCalled();
    expect(mocks.projectCreate).toHaveBeenCalledTimes(1);
    const createArgs = mocks.projectCreate.mock.calls[0]![0] as {
      data: { webhookId: number | null };
    };
    expect(createArgs.data.webhookId).toBeNull();
  });

  it.each(['--upload-pack=x', '-foo', 'a b', 'a..b'])(
    'rejects a malicious/unsafe branch name with 400: %s',
    async (branch) => {
      const app = createApp();
      const res = await supertest(app)
        .post('/api/projects')
        .set('X-Requested-With', 'XMLHttpRequest')
        .send({ repoUrl: 'https://github.com/octocat/hello', name: 'Hello', branch });
      expect(res.status).toBe(400);
      // Validation fails before any GitHub/Azure work is attempted.
      expect(mocks.createContainerApp).not.toHaveBeenCalled();
    },
  );

  it.each(['main', 'feature/x', 'release-1.2.3'])(
    'accepts a valid git-ref branch name (201): %s',
    async (branch) => {
      const app = createApp();
      const res = await supertest(app)
        .post('/api/projects')
        .set('X-Requested-With', 'XMLHttpRequest')
        .send({ repoUrl: 'https://github.com/octocat/hello', name: 'Hello', branch });
      expect(res.status).toBe(201);
      expect(res.body.branch).toBe(branch);
    },
  );

  it('rolls back the container app and returns 502 on hook 500', async () => {
    mocks.octokitRequest.mockImplementation(async (route: string) => {
      if (route.startsWith('GET /repos/')) {
        return { data: { id: 12345, default_branch: 'main' } };
      }
      if (route === 'POST /repos/{owner}/{repo}/hooks') {
        const err: Error & { status?: number; response?: { data: { message: string } } } =
          new Error('Server Error');
        err.status = 500;
        err.response = { data: { message: 'Internal Server Error' } };
        throw err;
      }
      return { data: {} };
    });

    const app = createApp();
    const res = await supertest(app)
      .post('/api/projects')
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({ repoUrl: 'https://github.com/octocat/hello', name: 'Hello' });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('GITHUB_API_ERROR');
    expect(mocks.deleteContainerApp).toHaveBeenCalledWith('octocat-hello');
    expect(mocks.projectCreate).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/projects/:id', () => {
  // branchSchema is shared between create and patch; this locks in the patch
  // path so a regression that loosens only the patch schema (the value flows to
  // `git clone --branch`) can't slip through unnoticed.
  it.each(['--upload-pack=x', '-foo', 'a b', 'a..b'])(
    'rejects a malicious/unsafe branch name with 400: %s',
    async (branch) => {
      const app = createApp();
      const res = await supertest(app)
        .patch('/api/projects/p1')
        .set('X-Requested-With', 'XMLHttpRequest')
        .send({ branch });
      expect(res.status).toBe(400);
      // Validation fails before any DB update is attempted.
      expect(mocks.projectUpdate).not.toHaveBeenCalled();
    },
  );
});

describe('DELETE /api/projects/:id', () => {
  function seedProject(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
    const project: ProjectRecord = {
      id: 'p1',
      userId: 'u1',
      name: 'Hello',
      slug: 'hello',
      githubRepoFullName: 'octocat/hello',
      githubRepoId: 12345,
      branch: 'main',
      webhookId: 99,
      containerAppName: 'octocat-hello',
      liveUrl: 'https://octocat-hello.example.com',
      frameworkHint: null,
      isDemo: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
      ...overrides,
    };
    state.projects.push(project);
    mocks.projectFindFirst.mockResolvedValue(project);
    mocks.projectUpdate.mockResolvedValue({ ...project, deletedAt: new Date() });
    return project;
  }

  it('calls Octokit DELETE when webhookId is set and returns 204', async () => {
    seedProject({ webhookId: 99 });
    const app = createApp();
    const res = await supertest(app)
      .delete('/api/projects/p1')
      .set('X-Requested-With', 'XMLHttpRequest');
    expect(res.status).toBe(204);
    const deleteCall = mocks.octokitRequest.mock.calls.find(
      (c) => c[0] === 'DELETE /repos/{owner}/{repo}/hooks/{hook_id}',
    );
    expect(deleteCall).toBeDefined();
    expect(deleteCall![1]).toMatchObject({ owner: 'octocat', repo: 'hello', hook_id: 99 });
  });

  it('still returns 204 when GitHub webhook delete fails with 500', async () => {
    seedProject({ webhookId: 99 });
    mocks.octokitRequest.mockImplementation(async (route: string) => {
      if (route === 'DELETE /repos/{owner}/{repo}/hooks/{hook_id}') {
        const err: Error & { status?: number; response?: { data: { message: string } } } =
          new Error('Server Error');
        err.status = 500;
        err.response = { data: { message: 'Internal Server Error' } };
        throw err;
      }
      return { data: {} };
    });

    const app = createApp();
    const res = await supertest(app)
      .delete('/api/projects/p1')
      .set('X-Requested-With', 'XMLHttpRequest');
    expect(res.status).toBe(204);
  });

  it('does not call Octokit DELETE when webhookId is null', async () => {
    seedProject({ webhookId: null });
    const app = createApp();
    const res = await supertest(app)
      .delete('/api/projects/p1')
      .set('X-Requested-With', 'XMLHttpRequest');
    expect(res.status).toBe(204);
    const deleteCall = mocks.octokitRequest.mock.calls.find(
      (c) => c[0] === 'DELETE /repos/{owner}/{repo}/hooks/{hook_id}',
    );
    expect(deleteCall).toBeUndefined();
  });
});

// --- Demo mode (docs/DEMO_MODE.md) -----------------------------------------
// CORE INVARIANT: an `isDemo` session must be PHYSICALLY UNABLE to reach
// Azure/ACR/git/real-GitHub. These tests assert each demo branch dispatches to
// the orchestrator / canned data BEFORE any external call, and that the real
// external mocks are never touched.
describe('demo mode', () => {
  /** A demo-owned project row for the per-project sub-resource routes. */
  function seedDemoProject(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
    const project: ProjectRecord = {
      id: 'demo-p1',
      userId: 'u1',
      name: 'Demo App',
      slug: 'demo-app',
      githubRepoFullName: 'prodstack-demo/express-api',
      githubRepoId: 4242,
      branch: 'main',
      webhookId: null,
      containerAppName: 'octocat-demo-app',
      liveUrl: null,
      frameworkHint: null,
      isDemo: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
      ...overrides,
    };
    state.projects.push(project);
    mocks.projectFindFirst.mockResolvedValue(project);
    mocks.projectUpdate.mockResolvedValue({ ...project, deletedAt: new Date() });
    return project;
  }

  beforeEach(() => {
    state.isDemo = true;
  });

  describe('POST /api/projects (create)', () => {
    it('dispatches to the orchestrator and never calls GitHub/Azure (201)', async () => {
      const app = createApp();
      const res = await supertest(app)
        .post('/api/projects')
        .set('X-Requested-With', 'XMLHttpRequest')
        .send({ repoUrl: 'https://github.com/prodstack-demo/express-api', name: 'Demo App' });

      expect(res.status).toBe(201);
      // Response is reshaped from the re-fetched row — byte-identical to a real create.
      expect(res.body.slug).toBe('demo-app');
      expect(res.body).not.toHaveProperty('webhookSecretCiphertext');

      // Dispatched to the orchestrator…
      expect(mocks.createDemoProject).toHaveBeenCalledTimes(1);
      // …and NEVER touched the real external paths (fail-closed).
      expect(mocks.octokitForUser).not.toHaveBeenCalled();
      expect(mocks.createContainerApp).not.toHaveBeenCalled();
      expect(mocks.projectCreate).not.toHaveBeenCalled();
    });

    it('accepts a non-GitHub / fake repo URL (the orchestrator tolerates it)', async () => {
      const app = createApp();
      const res = await supertest(app)
        .post('/api/projects')
        .set('X-Requested-With', 'XMLHttpRequest')
        .send({ repoUrl: 'not-a-real-url', name: 'Demo App' });
      expect(res.status).toBe(201);
      expect(mocks.createDemoProject).toHaveBeenCalledTimes(1);
      expect(mocks.octokitForUser).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/projects/:id/rebuild', () => {
    it('dispatches to startDemoBuild and never calls GitHub (202)', async () => {
      seedDemoProject();
      const app = createApp();
      const res = await supertest(app)
        .post('/api/projects/demo-p1/rebuild')
        .set('X-Requested-With', 'XMLHttpRequest');

      expect(res.status).toBe(202);
      expect(res.body.buildId).toBe('demo-b1');

      expect(mocks.startDemoBuild).toHaveBeenCalledTimes(1);
      expect(mocks.startDemoBuild).toHaveBeenCalledWith({
        id: 'demo-p1',
        branch: 'main',
        githubRepoFullName: 'prodstack-demo/express-api',
      });
      // Fail-closed: no GitHub commit lookup.
      expect(mocks.octokitForUser).not.toHaveBeenCalled();
      expect(mocks.fetchBranchHeadCommit).not.toHaveBeenCalled();
    });

    it('still honors the in-flight guard for demo (409, no orchestrator call)', async () => {
      seedDemoProject();
      mocks.buildFindFirst.mockResolvedValueOnce({ id: 'b-running' });
      const app = createApp();
      const res = await supertest(app)
        .post('/api/projects/demo-p1/rebuild')
        .set('X-Requested-With', 'XMLHttpRequest');
      expect(res.status).toBe(409);
      expect(mocks.startDemoBuild).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/projects/:id/metrics', () => {
    it('returns synthesized metrics without an Azure Monitor call', async () => {
      seedDemoProject();
      const app = createApp();
      const res = await supertest(app).get('/api/projects/demo-p1/metrics');
      expect(res.status).toBe(200);
      expect(res.body.available).toBe(true);
      expect(Array.isArray(res.body.series)).toBe(true);
      expect(res.body.series.length).toBeGreaterThan(0);
      // Fail-closed: the real Azure-Monitor path was never entered (regression
      // guard — without the demo branch this stub would not be used).
      expect(mocks.getAppMetrics).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/projects/:id/runtime/logs', () => {
    it('returns synthesized runtime logs without a Log Analytics call', async () => {
      seedDemoProject();
      const app = createApp();
      const res = await supertest(app).get('/api/projects/demo-p1/runtime/logs');
      expect(res.status).toBe(200);
      expect(res.body.available).toBe(true);
      expect(Array.isArray(res.body.lines)).toBe(true);
      expect(res.body.lines.length).toBeGreaterThan(0);
      // Fail-closed: the real Log-Analytics path was never entered.
      expect(mocks.queryRuntimeLogs).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/projects/:id/deployments/:deploymentId/rollback', () => {
    it('dispatches to the DB-only orchestrator and never calls updateContainerApp (201)', async () => {
      seedDemoProject();
      const app = createApp();
      const res = await supertest(app)
        .post('/api/projects/demo-p1/deployments/demo-dep1/rollback')
        .set('X-Requested-With', 'XMLHttpRequest');

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ active: true, rolledBack: true });
      expect(mocks.rollbackDemoDeployment).toHaveBeenCalledWith({
        projectId: 'demo-p1',
        deploymentId: 'demo-dep1',
        userId: 'u1',
      });
      // Fail-closed: the real rollback service (→ updateContainerApp) is never hit.
      expect(mocks.updateContainerApp).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /api/projects/:id (env vars)', () => {
    it('saves env vars but never triggers a real redeploy for demo', async () => {
      seedDemoProject();
      const app = createApp();
      const res = await supertest(app)
        .patch('/api/projects/demo-p1')
        .set('X-Requested-With', 'XMLHttpRequest')
        .send({ envVars: [{ key: 'API_KEY', value: 'secret-123' }] });

      expect(res.status).toBe(200);
      // The env-var rows are persisted (the tx ran) but the redeploy is skipped.
      expect(mocks.redeployWithCurrentEnv).not.toHaveBeenCalled();
      expect(res.body.redeploy).toEqual({ redeployed: false, reason: 'DEMO' });
    });
  });

  describe('DELETE /api/projects/:id', () => {
    it('soft-deletes but never calls deleteContainerApp / GitHub (204)', async () => {
      // A demo project never has a real webhook, but seed one to prove the guard
      // skips the octokit path regardless.
      seedDemoProject({ webhookId: 77 });
      const app = createApp();
      const res = await supertest(app)
        .delete('/api/projects/demo-p1')
        .set('X-Requested-With', 'XMLHttpRequest');
      expect(res.status).toBe(204);
      expect(mocks.projectUpdate).toHaveBeenCalledTimes(1); // soft-delete happened
      expect(mocks.deleteContainerApp).not.toHaveBeenCalled();
      expect(mocks.octokitForUser).not.toHaveBeenCalled();
    });
  });
});
