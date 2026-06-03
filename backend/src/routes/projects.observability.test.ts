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

// Metrics + runtime-logs endpoints exercise the AZURE_STUB branches of the
// metrics/logs services, so no real Azure is touched — we only mock the owned-
// project lookup + auth and assert the stubbed payloads flow through.

const state = vi.hoisted(() => ({ stubAuth: true }));

const projectRow = {
  id: 'p1',
  userId: 'u1',
  name: 'Hello',
  slug: 'hello',
  githubRepoFullName: 'octocat/hello',
  githubRepoId: 12345,
  branch: 'main',
  webhookId: null as number | null,
  containerAppName: 'octocat-hello',
  liveUrl: null as string | null,
  frameworkHint: null as string | null,
  autoDeploy: true,
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null as Date | null,
};

const mocks = vi.hoisted(() => ({ projectFindFirst: vi.fn() }));

vi.mock('../db.js', () => ({
  prisma: { project: { findFirst: mocks.projectFindFirst } },
}));

vi.mock('../middleware/requireAuth.js', () => ({
  requireAuth: (
    req: { user?: unknown },
    res: { status: (n: number) => { json: (b: unknown) => void } },
    next: () => void,
  ) => {
    if (state.stubAuth) {
      req.user = { id: 'u1', githubLogin: 'octocat' };
      next();
      return;
    }
    res.status(401).json({ error: 'UNAUTHORIZED' });
  },
}));

vi.mock('./auth.js', async () => {
  const express = await import('express');
  return { default: express.Router() };
});

vi.mock('../services/azure/index.js', () => ({
  createContainerApp: vi.fn(),
  updateContainerApp: vi.fn(),
  deleteContainerApp: vi.fn(),
}));

const { createApp } = await import('../app.js');
const supertest = (await import('supertest')).default;

beforeEach(() => {
  state.stubAuth = true;
  mocks.projectFindFirst.mockReset();
  mocks.projectFindFirst.mockImplementation(
    async (args: { where?: { id?: string; userId?: string; deletedAt?: null | Date } }) => {
      if (
        args?.where?.id === 'p1' &&
        args.where.userId === 'u1' &&
        args.where.deletedAt === null
      ) {
        return { ...projectRow };
      }
      return null;
    },
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/projects/:id/metrics', () => {
  it('rejects unauthenticated requests with 401', async () => {
    state.stubAuth = false;
    const res = await supertest(createApp()).get('/api/projects/p1/metrics');
    expect(res.status).toBe(401);
  });

  it('404 when the project is not owned by the user', async () => {
    const res = await supertest(createApp()).get('/api/projects/nope/metrics');
    expect(res.status).toBe(404);
  });

  it('returns the four metric series for the chosen range (stub)', async () => {
    const res = await supertest(createApp()).get('/api/projects/p1/metrics?range=6h');
    expect(res.status).toBe(200);
    expect(res.body.range).toBe('6h');
    expect(res.body.intervalMinutes).toBe(15);
    expect(res.body.series.map((s: { key: string }) => s.key)).toEqual([
      'cpu',
      'memory',
      'replicas',
      'requests',
    ]);
    for (const s of res.body.series) {
      expect(Array.isArray(s.points)).toBe(true);
      expect(s.points.length).toBeGreaterThan(0);
    }
  });

  it('defaults the range to 1h when omitted', async () => {
    const res = await supertest(createApp()).get('/api/projects/p1/metrics');
    expect(res.status).toBe(200);
    expect(res.body.range).toBe('1h');
    expect(res.body.intervalMinutes).toBe(5);
  });
});

describe('GET /api/projects/:id/runtime/logs', () => {
  it('404 when the project is not owned', async () => {
    const res = await supertest(createApp()).get('/api/projects/nope/runtime/logs');
    expect(res.status).toBe(404);
  });

  it('returns stubbed runtime log lines (available:true)', async () => {
    const res = await supertest(createApp()).get('/api/projects/p1/runtime/logs');
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
    expect(Array.isArray(res.body.lines)).toBe(true);
    expect(res.body.lines.length).toBeGreaterThan(0);
    expect(res.body.lines[0]).toHaveProperty('ts');
    expect(res.body.lines[0]).toHaveProperty('message');
  });

  it('returns no new lines when tailing with afterTs (stub)', async () => {
    const after = encodeURIComponent(new Date().toISOString());
    const res = await supertest(createApp()).get(`/api/projects/p1/runtime/logs?afterTs=${after}`);
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
    expect(res.body.lines).toEqual([]);
  });
});
