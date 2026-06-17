// Preview routes: GET /:id/previews, POST /:id/previews/:previewId/teardown,
// and the previewsEnabled PATCH. Mirrors the route-test harness in
// projects.stopResume.test.ts (mocked db + azure + auth, supertest via createApp).
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

import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ isDemo: false }));

const mocks = vi.hoisted(() => ({
  projectFindFirst: vi.fn(),
  txProjectUpdate: vi.fn(),
  txProjectFindFirstOrThrow: vi.fn(),
  transaction: vi.fn(),
  previewFindFirst: vi.fn(),
  previewFindUniqueOrThrow: vi.fn(),
  listPreviews: vi.fn(),
  teardownPreview: vi.fn(),
}));

vi.mock('../db.js', () => ({
  prisma: {
    project: { findFirst: mocks.projectFindFirst },
    previewEnvironment: {
      findFirst: mocks.previewFindFirst,
      findUniqueOrThrow: mocks.previewFindUniqueOrThrow,
    },
    $transaction: mocks.transaction,
  },
}));

vi.mock('../services/previews/previewService.js', () => ({
  listPreviews: mocks.listPreviews,
  teardownPreview: mocks.teardownPreview,
}));

vi.mock('../services/azure/index.js', () => ({
  createContainerApp: vi.fn(),
  updateContainerApp: vi.fn(),
  deleteContainerApp: vi.fn(),
  stopContainerApp: vi.fn(),
  startContainerApp: vi.fn(),
}));

vi.mock('../middleware/requireAuth.js', () => ({
  requireAuth: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { id: 'u1', githubLogin: 'octocat', isDemo: state.isDemo };
    next();
  },
}));
vi.mock('./auth.js', async () => {
  const express = await import('express');
  return { default: express.Router() };
});

const { createApp } = await import('../app.js');
const supertest = (await import('supertest')).default;
const xrw = { 'X-Requested-With': 'XMLHttpRequest' };

function projectRow(over: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    userId: 'u1',
    name: 'demo',
    slug: 'demo',
    githubRepoFullName: 'octocat/demo',
    githubRepoId: 12345,
    branch: 'main',
    webhookId: 99,
    containerAppName: 'octocat-demo',
    liveUrl: 'https://octocat-demo.example.com',
    frameworkHint: null,
    autoDeploy: true,
    previewsEnabled: true,
    status: 'ACTIVE',
    stoppedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...over,
  };
}

function previewRow(over: Record<string, unknown> = {}) {
  return {
    id: 'pv1',
    prNumber: 7,
    title: 'Add feature',
    headRef: 'feature-x',
    headSha: 'a'.repeat(40),
    authorLogin: 'octocat',
    status: 'ACTIVE',
    liveUrl: 'https://pr7-abcd1234.example.test',
    lastBuildId: 'b1',
    expiresAt: new Date(),
    closedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

beforeEach(() => {
  state.isDemo = false;
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.projectFindFirst.mockResolvedValue(projectRow());
  mocks.transaction.mockImplementation(
    async (fn: (t: { project: { update: typeof mocks.txProjectUpdate; findFirstOrThrow: typeof mocks.txProjectFindFirstOrThrow } }) => Promise<unknown>) =>
      fn({ project: { update: mocks.txProjectUpdate, findFirstOrThrow: mocks.txProjectFindFirstOrThrow } }),
  );
});

describe('GET /api/projects/:id/previews', () => {
  it('returns the project\'s previews for the owner', async () => {
    mocks.listPreviews.mockResolvedValue([previewRow()]);
    const res = await supertest(createApp()).get('/api/projects/p1/previews');
    expect(res.status).toBe(200);
    expect(res.body.previews).toHaveLength(1);
    expect(res.body.previews[0]).toMatchObject({ prNumber: 7, status: 'ACTIVE' });
    expect(mocks.listPreviews).toHaveBeenCalledWith('p1');
  });

  it('404s when the project is not owned', async () => {
    mocks.projectFindFirst.mockResolvedValue(null);
    const res = await supertest(createApp()).get('/api/projects/p1/previews');
    expect(res.status).toBe(404);
    expect(mocks.listPreviews).not.toHaveBeenCalled();
  });
});

describe('POST /api/projects/:id/previews/:previewId/teardown', () => {
  it('tears down an owned preview and returns the updated (TORN_DOWN) row', async () => {
    mocks.previewFindFirst.mockResolvedValue(previewRow());
    mocks.teardownPreview.mockResolvedValue(undefined);
    mocks.previewFindUniqueOrThrow.mockResolvedValue(previewRow({ status: 'TORN_DOWN', closedAt: new Date(), liveUrl: null }));

    const res = await supertest(createApp()).post('/api/projects/p1/previews/pv1/teardown').set(xrw);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('TORN_DOWN');
    expect(mocks.teardownPreview).toHaveBeenCalledWith('pv1');
  });

  it('404s when the preview does not belong to the project', async () => {
    mocks.previewFindFirst.mockResolvedValue(null);
    const res = await supertest(createApp()).post('/api/projects/p1/previews/pvX/teardown').set(xrw);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('PREVIEW_NOT_FOUND');
    expect(mocks.teardownPreview).not.toHaveBeenCalled();
  });

  it('403s for a demo session (never reaches Azure)', async () => {
    state.isDemo = true;
    const res = await supertest(createApp()).post('/api/projects/p1/previews/pv1/teardown').set(xrw);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('DEMO_NOT_SUPPORTED');
    expect(mocks.teardownPreview).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/projects/:id — previewsEnabled', () => {
  it('persists previewsEnabled', async () => {
    mocks.txProjectUpdate.mockResolvedValue({});
    mocks.txProjectFindFirstOrThrow.mockResolvedValue({ ...projectRow({ previewsEnabled: false }), builds: [], deployments: [] });

    const res = await supertest(createApp())
      .patch('/api/projects/p1')
      .set(xrw)
      .send({ previewsEnabled: false });

    expect(res.status).toBe(200);
    expect(res.body.previewsEnabled).toBe(false);
    const updateArg = mocks.txProjectUpdate.mock.calls[0]![0];
    expect(updateArg.data).toMatchObject({ previewsEnabled: false });
  });
});
