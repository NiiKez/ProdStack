// Per-session isolation (docs/DEMO_MODE.md §2). The demo design's load-bearing
// claim is "each demo session is its own User row, and every query is already
// userId-scoped, so sessions are isolated for free." This suite proves that
// claim by exercising the REAL `requireOwnedProject` / list scoping against a
// userId-honoring prisma mock: a session can never read another session's (or
// the real owner's) project, and vice-versa.
process.env.NODE_ENV = 'test';
process.env.DATA_ENC_KEY ??= Buffer.alloc(32, 9).toString('base64');
process.env.JWT_SECRET ??= 'x'.repeat(40);
process.env.COOKIE_SECRET ??= 'y'.repeat(40);
process.env.WEB_ORIGIN ??= 'http://localhost:5173';
process.env.GITHUB_OAUTH_CLIENT_ID ??= 'cid';
process.env.GITHUB_OAUTH_CLIENT_SECRET ??= 'csecret';
process.env.GITHUB_OAUTH_CALLBACK_URL ??= 'http://localhost:3000/api/auth/github/callback';
process.env.DATABASE_URL ??= 'postgresql://test/test';
process.env.AZURE_STUB = 'true';
process.env.LOG_LEVEL ??= 'silent';

import { beforeEach, describe, expect, it, vi } from 'vitest';

interface Row {
  id: string;
  userId: string;
  slug: string;
  containerAppName: string;
  deletedAt: Date | null;
}

// The acting session — flipped per test to simulate different demo/real users.
const state = vi.hoisted(() => ({
  user: { id: 'demo-A', githubLogin: 'demo-aaa', email: null, avatarUrl: null, isDemo: true },
  rows: [] as Row[],
}));

// A userId-honoring prisma mock — this is the whole point: it enforces the same
// `where: { id, userId, deletedAt }` scoping the real DB would, so the test
// actually verifies the route's ownership filter rather than a flat stub.
const mocks = vi.hoisted(() => ({
  projectFindFirst: vi.fn(),
  projectFindMany: vi.fn(),
  userFindUnique: vi.fn(),
}));

vi.mock('../db.js', () => ({
  prisma: {
    user: { findUnique: mocks.userFindUnique },
    project: { findFirst: mocks.projectFindFirst, findMany: mocks.projectFindMany },
  },
}));

vi.mock('../middleware/requireAuth.js', () => ({
  requireAuth: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { ...state.user };
    next();
  },
}));

vi.mock('./auth.js', async () => {
  const express = await import('express');
  return { default: express.Router() };
});

const { createApp } = await import('../app.js');
const supertest = (await import('supertest')).default;

beforeEach(() => {
  mocks.projectFindFirst.mockReset();
  mocks.projectFindMany.mockReset();
  mocks.userFindUnique.mockReset();

  // Honor the real ownership predicate `{ id, userId, deletedAt: null }`.
  mocks.projectFindFirst.mockImplementation(
    async (args: { where: { id: string; userId: string; deletedAt: null } }) => {
      const { id, userId } = args.where;
      return (
        state.rows.find((r) => r.id === id && r.userId === userId && r.deletedAt === null) ?? null
      );
    },
  );
  // Honor the list predicate `{ userId, deletedAt: null }`.
  mocks.projectFindMany.mockImplementation(
    async (args: { where: { userId: string; deletedAt: null } }) => {
      const { userId } = args.where;
      return state.rows
        .filter((r) => r.userId === userId && r.deletedAt === null)
        .map((r) => ({
          ...r,
          name: r.slug,
          githubRepoFullName: 'demo/x',
          githubRepoId: 1,
          branch: 'main',
          webhookId: null,
          liveUrl: null,
          frameworkHint: null,
          autoDeploy: true,
          createdAt: new Date(),
          updatedAt: new Date(),
          builds: [],
          deployments: [],
        }));
    },
  );
});

function asUser(id: string, isDemo: boolean) {
  state.user = { id, githubLogin: `${id}-login`, email: null, avatarUrl: null, isDemo };
}

// demo-A owns project P; the row lives in the shared store.
function seedProjectP() {
  state.rows = [
    { id: 'P', userId: 'demo-A', slug: 'p', containerAppName: 'demo-p', deletedAt: null },
  ];
}

describe('cross-session isolation', () => {
  it('lets the owning demo session read its own project metrics (200)', async () => {
    seedProjectP();
    asUser('demo-A', true);
    const res = await supertest(createApp()).get('/api/projects/P/metrics');
    expect(res.status).toBe(200);
  });

  it("404s a different demo session reading session A's project", async () => {
    seedProjectP();
    asUser('demo-B', true);
    const res = await supertest(createApp()).get('/api/projects/P/metrics');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('PROJECT_NOT_FOUND');
  });

  it("404s the real owner reading a demo session's project (and vice-versa)", async () => {
    seedProjectP();
    asUser('real-owner', false);
    const res = await supertest(createApp()).get('/api/projects/P/metrics');
    expect(res.status).toBe(404);
  });

  it("404s a cross-session rebuild attempt before any orchestrator/build work", async () => {
    seedProjectP();
    asUser('demo-B', true);
    const res = await supertest(createApp())
      .post('/api/projects/P/rebuild')
      .set('X-Requested-With', 'XMLHttpRequest');
    expect(res.status).toBe(404);
  });

  it('scopes the project list to the acting session only', async () => {
    state.rows = [
      { id: 'P', userId: 'demo-A', slug: 'p', containerAppName: 'demo-p', deletedAt: null },
      { id: 'Q', userId: 'demo-B', slug: 'q', containerAppName: 'demo-q', deletedAt: null },
      { id: 'R', userId: 'real-owner', slug: 'r', containerAppName: 'real-r', deletedAt: null },
    ];

    asUser('demo-B', true);
    const resB = await supertest(createApp()).get('/api/projects');
    expect(resB.status).toBe(200);
    expect(resB.body.projects.map((p: { id: string }) => p.id)).toEqual(['Q']);

    asUser('real-owner', false);
    const resOwner = await supertest(createApp()).get('/api/projects');
    expect(resOwner.body.projects.map((p: { id: string }) => p.id)).toEqual(['R']);
  });
});
