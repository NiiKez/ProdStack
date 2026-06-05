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
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

const tokenField = encrypt('ghp_dummy_token');

const state = vi.hoisted(() => ({
  stubAuth: true,
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
};

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  projectFindMany: vi.fn(),
  projectFindFirst: vi.fn(),
  projectCreate: vi.fn(),
  projectUpdate: vi.fn(),
  projectCount: vi.fn(),
  queryRaw: vi.fn(),
  octokitForUser: vi.fn(),
  octokitRequest: vi.fn(),
  createContainerApp: vi.fn(),
  updateContainerApp: vi.fn(),
  deleteContainerApp: vi.fn(),
}));

vi.mock('../db.js', () => ({
  prisma: {
    user: { findUnique: mocks.userFindUnique },
    project: {
      findMany: mocks.projectFindMany,
      findFirst: mocks.projectFindFirst,
      create: mocks.projectCreate,
      update: mocks.projectUpdate,
      count: mocks.projectCount,
    },
    $queryRaw: mocks.queryRaw,
  },
}));

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
  state.projects.length = 0;

  mocks.userFindUnique.mockReset();
  mocks.projectFindMany.mockReset();
  mocks.projectFindFirst.mockReset();
  mocks.projectCreate.mockReset();
  mocks.projectUpdate.mockReset();
  mocks.projectCount.mockReset();
  mocks.queryRaw.mockReset();
  mocks.octokitForUser.mockReset();
  mocks.octokitRequest.mockReset();
  mocks.createContainerApp.mockReset();
  mocks.updateContainerApp.mockReset();
  mocks.deleteContainerApp.mockReset();

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

  it('reuses a slug whose project has been soft-deleted', async () => {
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
    expect(args.events).toEqual(['push']);
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
