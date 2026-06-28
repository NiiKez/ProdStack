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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ stubAuth: true, isDemo: false }));

const mocks = vi.hoisted(() => ({
  buildFindMany: vi.fn(),
  deploymentFindMany: vi.fn(),
  projectFindMany: vi.fn(),
  securityEventFindMany: vi.fn(),
}));

vi.mock('../db.js', () => ({
  prisma: {
    build: { findMany: mocks.buildFindMany },
    deployment: { findMany: mocks.deploymentFindMany },
    project: { findMany: mocks.projectFindMany },
    securityEvent: { findMany: mocks.securityEventFindMany },
  },
}));

vi.mock('../middleware/requireAuth.js', () => ({
  requireAuth: (
    req: { user?: unknown },
    res: { status: (n: number) => { json: (b: unknown) => void } },
    next: () => void,
  ) => {
    if (state.stubAuth) {
      req.user = { id: 'u1', githubLogin: 'octocat', email: null, avatarUrl: null, isDemo: state.isDemo };
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

const { createApp } = await import('../app.js');
const supertest = (await import('supertest')).default;

beforeEach(() => {
  state.stubAuth = true;
  state.isDemo = false;
  mocks.buildFindMany.mockReset();
  mocks.deploymentFindMany.mockReset();
  mocks.projectFindMany.mockReset();
  mocks.securityEventFindMany.mockReset();
  mocks.buildFindMany.mockResolvedValue([]);
  mocks.deploymentFindMany.mockResolvedValue([]);
  mocks.projectFindMany.mockResolvedValue([]);
  mocks.securityEventFindMany.mockResolvedValue([]);
});

afterEach(() => vi.clearAllMocks());

describe('GET /api/activity', () => {
  it('401 when unauthenticated', async () => {
    state.stubAuth = false;
    const res = await supertest(createApp()).get('/api/activity');
    expect(res.status).toBe(401);
  });

  it('400s a malformed projectId filter (shape-validated, never reaches the DB)', async () => {
    // A non-cuid-ish projectId is rejected up front rather than silently
    // filtered — mirrors the deployments feed's PROJECT_ID_RE contract.
    const res = await supertest(createApp()).get('/api/activity?projectId=../../etc');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'VALIDATION_FAILED' });
    expect(mocks.buildFindMany).not.toHaveBeenCalled();
  });

  it('expands a terminal build into queued + succeeded events, newest first', async () => {
    mocks.buildFindMany.mockResolvedValue([
      {
        id: 'b1',
        projectId: 'p1',
        status: 'READY',
        commitSha: 'abc1234',
        commitMessage: 'ship',
        commitAuthor: 'octocat',
        createdAt: new Date('2026-05-31T09:59:00Z'),
        finishedAt: new Date('2026-05-31T10:00:00Z'),
        project: { id: 'p1', name: 'app' },
      },
    ]);
    const res = await supertest(createApp()).get('/api/activity');
    expect(res.status).toBe(200);
    const types = res.body.items.map((e: { type: string }) => e.type);
    expect(types).toEqual(['build.succeeded', 'build.queued']);
    expect(res.body.items[0]).toMatchObject({
      type: 'build.succeeded',
      projectName: 'app',
      commitSha: 'abc1234',
    });
  });

  it('labels rolled-back deployments distinctly and merges all sources by time', async () => {
    mocks.deploymentFindMany.mockResolvedValue([
      {
        id: 'd1',
        projectId: 'p1',
        rolledBack: true,
        createdAt: new Date('2026-05-31T12:00:00Z'),
        project: { id: 'p1', name: 'app' },
        build: { id: 'b1', commitSha: 'abc1234', commitMessage: 'ship', commitAuthor: 'octocat' },
      },
    ]);
    mocks.projectFindMany.mockResolvedValue([
      { id: 'p1', name: 'app', createdAt: new Date('2026-05-30T08:00:00Z'), deletedAt: null },
    ]);
    const res = await supertest(createApp()).get('/api/activity');
    const types = res.body.items.map((e: { type: string }) => e.type);
    expect(types).toEqual(['deployment.rollback', 'project.created']);
  });

  it('filters by event type', async () => {
    mocks.projectFindMany.mockResolvedValue([
      { id: 'p1', name: 'app', createdAt: new Date('2026-05-30T08:00:00Z'), deletedAt: new Date('2026-05-31T08:00:00Z') },
    ]);
    const res = await supertest(createApp()).get('/api/activity?type=project.deleted');
    const types = res.body.items.map((e: { type: string }) => e.type);
    expect(types).toEqual(['project.deleted']);
  });

  it('drops events at/after the keyset cursor', async () => {
    mocks.projectFindMany.mockResolvedValue([
      { id: 'p1', name: 'old', createdAt: new Date('2026-05-01T00:00:00Z'), deletedAt: null },
      { id: 'p2', name: 'new', createdAt: new Date('2026-05-31T00:00:00Z'), deletedAt: null },
    ]);
    const cursor = encodeCursor(new Date('2026-05-15T00:00:00.000Z').getTime(), 'zzz');
    const res = await supertest(createApp()).get(`/api/activity?cursor=${cursor}`);
    const ids = res.body.items.map((e: { projectId: string }) => e.projectId);
    expect(ids).toEqual(['p1']);
  });

  it('rejects a malformed cursor with 400', async () => {
    const res = await supertest(createApp()).get('/api/activity?cursor=not-a-cursor');
    expect(res.status).toBe(400);
  });

  it('does not drop a sibling event sharing the same millisecond across a page boundary', async () => {
    // Two project.created events at the exact same ms — the old timestamp-only
    // `lt` cursor would silently skip one at the boundary. limit=1 forces the
    // boundary to fall between them.
    const ts = new Date('2026-05-20T00:00:00.000Z');
    mocks.projectFindMany.mockResolvedValue([
      { id: 'p1', name: 'a', createdAt: ts, deletedAt: null },
      { id: 'p2', name: 'b', createdAt: ts, deletedAt: null },
    ]);

    const page1 = await supertest(createApp()).get('/api/activity?limit=1');
    expect(page1.body.items).toHaveLength(1);
    expect(page1.body.nextCursor).toBeTruthy();
    const firstId = page1.body.items[0].projectId;

    const page2 = await supertest(createApp()).get(
      `/api/activity?limit=1&cursor=${encodeURIComponent(page1.body.nextCursor)}`,
    );
    expect(page2.body.items).toHaveLength(1);
    const secondId = page2.body.items[0].projectId;

    // Both siblings surface exactly once across the two pages — none lost.
    expect(new Set([firstId, secondId])).toEqual(new Set(['p1', 'p2']));
  });
});

describe('GET /api/activity/security-events (owner-gated audit read-back)', () => {
  const sampleRow = {
    id: 'ev1',
    createdAt: new Date('2026-06-28T10:00:00Z'),
    action: 'auth.login',
    outcome: 'success',
    actorGithubId: 182921896,
    actorLogin: 'NiiKez',
    userId: 'u1',
    targetType: null,
    targetId: null,
    ip: '203.0.113.7',
    metadata: { created: false },
  };

  it('401 when unauthenticated', async () => {
    state.stubAuth = false;
    const res = await supertest(createApp()).get('/api/activity/security-events');
    expect(res.status).toBe(401);
    expect(mocks.securityEventFindMany).not.toHaveBeenCalled();
  });

  it('403 for a demo session (the global audit trail is not theirs to read)', async () => {
    state.isDemo = true;
    const res = await supertest(createApp()).get('/api/activity/security-events');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'DEMO_NOT_SUPPORTED' });
    expect(mocks.securityEventFindMany).not.toHaveBeenCalled();
  });

  it('returns recent events for the authenticated owner, newest-first + serialized', async () => {
    mocks.securityEventFindMany.mockResolvedValue([sampleRow]);
    const res = await supertest(createApp()).get('/api/activity/security-events');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({
      id: 'ev1',
      action: 'auth.login',
      outcome: 'success',
      actorLogin: 'NiiKez',
      ip: '203.0.113.7',
      metadata: { created: false },
    });
    expect(res.body.nextCursor).toBeNull();
    // Bounded + ordered newest-first with a stable id tiebreak.
    const args = mocks.securityEventFindMany.mock.calls[0]![0]!;
    expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    expect(args.take).toBe(51); // default limit 50 + 1 peek
  });

  it('caps the page and returns a nextCursor when there is more', async () => {
    // limit=2 → take=3; return 3 rows so hasMore is true.
    const rows = [1, 2, 3].map((n) => ({ ...sampleRow, id: `ev${n}` }));
    mocks.securityEventFindMany.mockResolvedValue(rows);
    const res = await supertest(createApp()).get('/api/activity/security-events?limit=2');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.nextCursor).toBe('ev2');
    expect(mocks.securityEventFindMany.mock.calls[0]![0]!.take).toBe(3);
  });

  it('filters by action when provided', async () => {
    mocks.securityEventFindMany.mockResolvedValue([]);
    const res = await supertest(createApp()).get(
      '/api/activity/security-events?action=auth.denied_not_owner',
    );
    expect(res.status).toBe(200);
    expect(mocks.securityEventFindMany.mock.calls[0]![0]!.where).toEqual({
      action: 'auth.denied_not_owner',
    });
  });

  it('400s an over-cap limit (bounded)', async () => {
    const res = await supertest(createApp()).get('/api/activity/security-events?limit=500');
    expect(res.status).toBe(400);
    expect(mocks.securityEventFindMany).not.toHaveBeenCalled();
  });
});

/** Mirror of the server's opaque `(ms,id)` cursor encoding for tests. */
function encodeCursor(ms: number, id: string): string {
  return Buffer.from(`${ms}:${id}`).toString('base64url');
}
