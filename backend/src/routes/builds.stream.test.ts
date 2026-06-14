// C2: the SSE log-stream endpoint caps how many concurrent streams one user may
// hold open (logStreamRegistry). This pins the WIRING — that the route rejects
// with 429 TOO_MANY_STREAMS when the registry is at capacity, before opening the
// stream — by mocking the registry. The acquire/release LOGIC itself is covered
// by lib/streamRegistry.test.ts, and the happy path (acquire→release on a
// completed stream) by the real registry in builds.test.ts.
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

import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  buildFindFirst: vi.fn(),
  buildFindUnique: vi.fn(),
  logLineFindMany: vi.fn(),
  tryAcquire: vi.fn(),
  release: vi.fn(),
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
    _res: unknown,
    next: () => void,
  ) => {
    req.user = { id: 'u1', githubLogin: 'octocat', email: null, avatarUrl: null };
    next();
  },
}));

vi.mock('./auth.js', async () => {
  const express = await import('express');
  return { default: express.Router() };
});

vi.mock('../lib/streamRegistry.js', () => ({
  logStreamRegistry: { tryAcquire: mocks.tryAcquire, release: mocks.release },
}));

const { createApp } = await import('../app.js');
const supertest = (await import('supertest')).default;

const ownedBuild = {
  id: 'build-1',
  status: 'BUILDING',
  project: { id: 'project-1', name: 'app', githubRepoFullName: 'octocat/app', containerAppName: 'octocat-app', liveUrl: null },
};

beforeEach(() => {
  mocks.buildFindFirst.mockReset();
  mocks.tryAcquire.mockReset();
  mocks.release.mockReset();
  mocks.buildFindFirst.mockResolvedValue(ownedBuild);
});

describe('GET /api/builds/:id/logs/stream — concurrency cap', () => {
  it('429s TOO_MANY_STREAMS (keyed on the user) when the registry is at capacity', async () => {
    mocks.tryAcquire.mockReturnValue(false);
    const res = await supertest(createApp()).get('/api/builds/build-1/logs/stream');
    expect(res.status).toBe(429);
    expect(res.body.error).toBe('TOO_MANY_STREAMS');
    expect(res.headers['retry-after']).toBe('5');
    // The cap is per authenticated user, and nothing was streamed.
    expect(mocks.tryAcquire).toHaveBeenCalledWith('u1');
    expect(mocks.logLineFindMany).not.toHaveBeenCalled();
  });

  it('does not consume a slot when the build is not the user’s (404 before acquire)', async () => {
    // Ownership check runs first; a foreign/missing build must not reserve a slot.
    mocks.buildFindFirst.mockResolvedValue(null);
    const res = await supertest(createApp()).get('/api/builds/build-1/logs/stream');
    expect(res.status).toBe(404);
    expect(mocks.tryAcquire).not.toHaveBeenCalled();
  });
});

describe('GET /api/builds/:id/logs/stream — setup-error handling', () => {
  it('returns a clean 500 (no hang, no slot reserved) when the build lookup rejects before streaming', async () => {
    // The pre-`writeHead` ownership lookup is the one `await` that runs before the
    // SSE response is committed. The handler is async with no `next`, and Express 4
    // does NOT route an async-handler rejection to the error middleware — so an
    // unguarded reject here would surface as an unhandledRejection and a hung
    // socket. This pins that a DB blip yields a fast 500 and reserves no slot.
    mocks.buildFindFirst.mockRejectedValue(new Error('db down'));
    const res = await supertest(createApp()).get('/api/builds/build-1/logs/stream');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('INTERNAL');
    expect(mocks.tryAcquire).not.toHaveBeenCalled();
  });
});

// These two exercise the live streaming loop, so they need a real socket the
// client can drop — supertest buffers the whole response and never lets go of the
// connection mid-stream. A BUILDING build keeps the stream open and polling.
describe('GET /api/builds/:id/logs/stream — teardown & poll integrity (real socket)', () => {
  const POLL_MS = 1000; // mirrors STREAM_POLL_MS in builds.ts

  beforeEach(() => {
    mocks.buildFindFirst.mockResolvedValue({ ...ownedBuild, status: 'BUILDING' });
    mocks.buildFindUnique.mockResolvedValue({ status: 'BUILDING', durationMs: null, errorMessage: null });
    mocks.logLineFindMany.mockReset();
    mocks.logLineFindMany.mockResolvedValue([]);
    mocks.tryAcquire.mockReturnValue(true);
  });

  async function listen(): Promise<{ server: http.Server; port: number }> {
    const server = http.createServer(createApp());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { server, port: (server.address() as AddressInfo).port };
  }

  it('tears down the poll/heartbeat timers and frees the slot when the connection drops (no orphaned polling)', async () => {
    const { server, port } = await listen();
    try {
      // Open the stream; on the first chunk (the prime `status` event, after which
      // the interval timers are armed) drop the client connection so the server's
      // `res` emits 'close'. The fix wires `cleanup` to BOTH req and res 'close',
      // so a response-side abort can't orphan the 1s Postgres poller.
      await new Promise<void>((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/api/builds/build-1/logs/stream' }, (res) => {
          res.on('error', () => {}); // swallow the ECONNRESET from our own destroy
          res.once('data', () => {
            req.destroy();
            resolve();
          });
        });
        req.on('error', reject);
      });

      await new Promise((r) => setTimeout(r, 150)); // let the close handler run
      const callsAfterDrop = mocks.logLineFindMany.mock.calls.length;
      expect(mocks.release).toHaveBeenCalledWith('u1');

      // A leaked pollTimer would call findMany again at the next interval. Wait
      // past one full interval and assert the count is frozen.
      await new Promise((r) => setTimeout(r, POLL_MS + 400));
      expect(mocks.logLineFindMany.mock.calls.length).toBe(callsAfterDrop);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('never runs overlapping polls when a drain outlasts the poll interval', async () => {
    // Make the prime poll's first DB read hang so it is still in flight across
    // multiple interval ticks. The reentrancy guard must make those ticks no-ops;
    // without it, each tick would launch another concurrent drain (findMany again),
    // double-sending log rows and racing the terminal-state machine.
    let releaseFindMany: ((rows: unknown[]) => void) | undefined;
    mocks.logLineFindMany.mockImplementationOnce(
      () => new Promise((resolve) => { releaseFindMany = resolve as (rows: unknown[]) => void; }),
    );

    const { server, port } = await listen();
    const req = http.get({ host: '127.0.0.1', port, path: '/api/builds/build-1/logs/stream' }, (res) => {
      res.on('error', () => {});
      res.on('data', () => {});
    });
    req.on('error', () => {});

    try {
      // Wait past two interval ticks while the prime drain is still pending.
      await new Promise((r) => setTimeout(r, POLL_MS * 2 + 300));
      // Exactly one findMany: the prime call (hung). The interval ticks saw the
      // in-flight poll and bailed instead of starting a second concurrent drain.
      expect(mocks.logLineFindMany).toHaveBeenCalledTimes(1);
    } finally {
      releaseFindMany?.([]); // let the prime poll finish
      req.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
