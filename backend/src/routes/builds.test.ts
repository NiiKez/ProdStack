// Set env vars before importing anything that loads `env.ts`.
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

import { createServer, get as httpGet, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ stubAuth: true }));

const mocks = vi.hoisted(() => ({
  buildFindFirst: vi.fn(),
  buildFindUnique: vi.fn(),
  logLineFindMany: vi.fn(),
}));

vi.mock('../db.js', () => ({
  prisma: {
    build: { findFirst: mocks.buildFindFirst, findUnique: mocks.buildFindUnique },
    logLine: { findMany: mocks.logLineFindMany },
  },
}));

vi.mock('../middleware/requireAuth.js', () => ({
  requireAuth: (
    req: { user?: unknown },
    res: { status: (n: number) => { json: (b: unknown) => void } },
    next: () => void,
  ) => {
    if (state.stubAuth) {
      req.user = { id: 'u1', githubLogin: 'octocat', email: null, avatarUrl: null };
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

const ownedBuild = {
  id: 'build-1',
  status: 'READY',
  commitSha: 'abc1234def',
  commitMessage: 'ship it',
  commitAuthor: 'octocat',
  branch: 'main',
  imageTag: 'prodstack.azurecr.io/octocat-app:abc1234def',
  startedAt: new Date('2026-05-31T10:00:00Z'),
  finishedAt: new Date('2026-05-31T10:01:00Z'),
  durationMs: 60_000,
  errorMessage: null,
  createdAt: new Date('2026-05-31T09:59:00Z'),
  project: {
    id: 'project-1',
    name: 'app',
    githubRepoFullName: 'octocat/app',
    containerAppName: 'octocat-app',
    liveUrl: 'https://octocat-app.example.azurecontainerapps.io',
  },
};

beforeEach(() => {
  state.stubAuth = true;
  mocks.buildFindFirst.mockReset();
  mocks.buildFindUnique.mockReset();
  mocks.logLineFindMany.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/builds/:id', () => {
  it('401 when unauthenticated', async () => {
    state.stubAuth = false;
    const res = await supertest(createApp()).get('/api/builds/build-1');
    expect(res.status).toBe(401);
  });

  it('404 when the build is not owned or missing', async () => {
    mocks.buildFindFirst.mockResolvedValue(null);
    const res = await supertest(createApp()).get('/api/builds/build-1');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('BUILD_NOT_FOUND');
  });

  it('200 with build detail for the owner, without leaking internal fields', async () => {
    mocks.buildFindFirst.mockResolvedValue(ownedBuild);
    const res = await supertest(createApp()).get('/api/builds/build-1');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('build-1');
    expect(res.body.status).toBe('READY');
    expect(res.body.project.githubRepoFullName).toBe('octocat/app');
    expect(res.body.project.containerAppName).toBeUndefined();
  });

  it('scopes the ownership check to the requesting user + live projects', async () => {
    mocks.buildFindFirst.mockResolvedValue(ownedBuild);
    await supertest(createApp()).get('/api/builds/build-1');
    const where = mocks.buildFindFirst.mock.calls[0]![0]!.where as {
      id: string;
      project: { userId: string; deletedAt: null };
    };
    expect(where.id).toBe('build-1');
    expect(where.project.userId).toBe('u1');
    expect(where.project.deletedAt).toBeNull();
  });
});

describe('GET /api/builds/:id/logs', () => {
  it('returns paginated lines + status + nextSeq', async () => {
    mocks.buildFindFirst.mockResolvedValue(ownedBuild);
    mocks.logLineFindMany.mockResolvedValue([
      { seq: 1, level: 'STEP', message: 'cloning', ts: new Date() },
      { seq: 2, level: 'SUCCESS', message: 'deployed', ts: new Date() },
    ]);
    const res = await supertest(createApp()).get('/api/builds/build-1/logs?afterSeq=0&limit=50');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('READY');
    expect(res.body.lines).toHaveLength(2);
    expect(res.body.nextSeq).toBe(2);
  });

  it('404 for a non-owned build before touching logs', async () => {
    mocks.buildFindFirst.mockResolvedValue(null);
    const res = await supertest(createApp()).get('/api/builds/build-1/logs');
    expect(res.status).toBe(404);
    expect(mocks.logLineFindMany).not.toHaveBeenCalled();
  });
});

describe('GET /api/builds/:id/logs/stream (SSE)', () => {
  // supertest resolves on the first flush and never waits for async SSE ticks,
  // so the stream is consumed over a real socket on an ephemeral port and the
  // body is collected until `done`.
  let server: Server;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function startServer(): Promise<number> {
    server = createServer(createApp());
    return new Promise<number>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
    );
  }

  function readStream(
    port: number,
    buildId: string,
    headers: Record<string, string> = {},
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const req = httpGet(
        { host: '127.0.0.1', port, path: `/api/builds/${buildId}/logs/stream`, headers },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            body += chunk;
            if (body.includes('event: done')) {
              req.destroy();
              resolve(body);
            }
          });
          res.on('end', () => resolve(body));
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      setTimeout(() => {
        req.destroy();
        reject(new Error('SSE stream timed out'));
      }, 8_000);
    });
  }

  it('replays logs + status then emits done for an already-terminal build', async () => {
    mocks.buildFindFirst.mockResolvedValue(ownedBuild);
    mocks.buildFindUnique.mockResolvedValue({
      status: 'READY',
      durationMs: 60_000,
      errorMessage: null,
    });
    mocks.logLineFindMany
      .mockResolvedValueOnce([
        { seq: 1, level: 'STEP', message: 'cloning', ts: new Date() },
        { seq: 2, level: 'SUCCESS', message: 'deployed', ts: new Date() },
      ])
      .mockResolvedValue([]);

    const port = await startServer();
    const body = await readStream(port, 'build-1');

    expect(body).toContain('event: log');
    expect(body).toContain('id: 2');
    expect(body).toContain('"message":"deployed"');
    expect(body).toContain('event: status');
    expect(body).toContain('"status":"READY"');
    expect(body).toContain('event: done');
  }, 10_000);

  it('streams a demo build byte-identically (the SSE path does not branch on isDemo)', async () => {
    // docs/DEMO_MODE.md §5: a demo build is just LogLine rows + Build.status the
    // demo driver wrote; the SSE endpoint reads them like any other build, so the
    // replayed stream is indistinguishable from a real deploy. No demo branch
    // exists in the stream handler — this pins that "zero SSE changes" claim.
    mocks.buildFindFirst.mockResolvedValue({ ...ownedBuild, isDemo: true });
    mocks.buildFindUnique.mockResolvedValue({ status: 'READY', durationMs: 15_000, errorMessage: null });
    mocks.logLineFindMany
      .mockResolvedValueOnce([
        { seq: 1, level: 'STEP', message: 'cloning repository at HEAD', ts: new Date() },
        { seq: 2, level: 'SUCCESS', message: 'deployed → https://demo-app.demo.prodstack.live', ts: new Date() },
      ])
      .mockResolvedValue([]);

    const port = await startServer();
    const body = await readStream(port, 'build-1');

    expect(body).toContain('event: log');
    expect(body).toContain('"message":"deployed → https://demo-app.demo.prodstack.live"');
    expect(body).toContain('"status":"READY"');
    expect(body).toContain('event: done');
  }, 10_000);

  it('resumes from Last-Event-ID, skipping already-seen lines', async () => {
    mocks.buildFindFirst.mockResolvedValue(ownedBuild);
    mocks.buildFindUnique.mockResolvedValue({ status: 'READY', durationMs: 1, errorMessage: null });
    mocks.logLineFindMany.mockResolvedValue([]);

    const port = await startServer();
    await readStream(port, 'build-1', { 'Last-Event-ID': '5' });

    const firstWhere = mocks.logLineFindMany.mock.calls[0]![0]!.where as { seq: { gt: number } };
    expect(firstWhere.seq.gt).toBe(5);
  }, 10_000);

  it('404 (not a stream) for a non-owned build', async () => {
    mocks.buildFindFirst.mockResolvedValue(null);
    const res = await supertest(createApp()).get('/api/builds/build-1/logs/stream');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('BUILD_NOT_FOUND');
  });
});
