import { createHmac } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { encrypt } from '../lib/crypto.js';

const WEBHOOK_SECRET = 'super-secret-webhook-key';

const state = vi.hoisted(() => ({
  webhookEvents: new Set<string>(),
  builds: [] as Array<{
    id: string;
    projectId: string;
    commitSha: string;
    commitMessage: string;
    commitAuthor: string;
    branch: string;
    status: string;
  }>,
  nextBuildId: 1,
}));

const projectRow = (() => {
  const enc = encrypt(WEBHOOK_SECRET);
  return {
    id: 'p1',
    userId: 'u1',
    name: 'Hello',
    slug: 'hello',
    githubRepoFullName: 'octocat/hello',
    githubRepoId: 12345,
    branch: 'main',
    webhookId: null as number | null,
    webhookSecretCiphertext: enc.ciphertext,
    webhookSecretIv: enc.iv,
    webhookSecretAuthTag: enc.authTag,
    webhookSecretKeyVersion: enc.keyVersion,
    containerAppName: 'octocat-hello',
    liveUrl: 'https://octocat-hello.example.com',
    frameworkHint: null as string | null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null as Date | null,
  };
})();

const mocks = vi.hoisted(() => ({
  projectFindFirst: vi.fn(),
  webhookEventCreate: vi.fn(),
  buildCreate: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('../db.js', () => {
  const tx = {
    webhookEvent: { create: mocks.webhookEventCreate },
    build: { create: mocks.buildCreate },
  };
  return {
    prisma: {
      project: { findFirst: mocks.projectFindFirst },
      webhookEvent: { create: mocks.webhookEventCreate },
      build: { create: mocks.buildCreate },
      $transaction: mocks.transaction.mockImplementation(
        async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
      ),
    },
  };
});

vi.mock('../middleware/requireAuth.js', () => ({
  requireAuth: (
    _req: { user?: unknown },
    res: { status: (n: number) => { json: (b: unknown) => void } },
    next: () => void,
  ) => {
    // Webhooks bypass auth (HMAC-authenticated). For other routes in this app
    // the middleware is still mounted, but no test in this file hits them, so
    // we just no-op here.
    void res;
    next();
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

function sign(body: string, secret = WEBHOOK_SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function pushPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ref: 'refs/heads/main',
    repository: { id: 12345 },
    head_commit: {
      id: 'a'.repeat(40),
      message: 'feat: ship it',
      author: { name: 'Octo Cat' },
    },
    ...overrides,
  });
}

beforeEach(() => {
  state.webhookEvents.clear();
  state.builds.length = 0;
  state.nextBuildId = 1;

  mocks.projectFindFirst.mockReset();
  mocks.webhookEventCreate.mockReset();
  mocks.buildCreate.mockReset();

  mocks.projectFindFirst.mockImplementation(
    async (args: { where?: { githubRepoId?: number; deletedAt?: null | Date } }) => {
      if (
        args?.where?.githubRepoId === projectRow.githubRepoId &&
        args.where.deletedAt === null
      ) {
        return { ...projectRow };
      }
      return null;
    },
  );

  mocks.webhookEventCreate.mockImplementation(
    async ({ data }: { data: { id: string; projectId: string } }) => {
      if (state.webhookEvents.has(data.id)) {
        const { Prisma } = await import('@prisma/client');
        throw new Prisma.PrismaClientKnownRequestError('duplicate', {
          code: 'P2002',
          clientVersion: 'test',
        });
      }
      state.webhookEvents.add(data.id);
      return { id: data.id, projectId: data.projectId, receivedAt: new Date() };
    },
  );

  mocks.buildCreate.mockImplementation(
    async ({
      data,
    }: {
      data: {
        projectId: string;
        commitSha: string;
        commitMessage: string;
        commitAuthor: string;
        branch: string;
        status: string;
      };
    }) => {
      const id = `b${state.nextBuildId++}`;
      const build = { id, ...data };
      state.builds.push(build);
      return { id };
    },
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/webhooks/github', () => {
  it('accepts a valid push on the tracked branch and returns 202 with buildId', async () => {
    const body = pushPayload();
    const app = createApp();
    const res = await supertest(app)
      .post('/api/webhooks/github')
      .set('Content-Type', 'application/json')
      .set('X-GitHub-Event', 'push')
      .set('X-GitHub-Delivery', 'delivery-1')
      .set('X-Hub-Signature-256', sign(body))
      .send(body);

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ buildId: 'b1' });
    expect(state.builds).toHaveLength(1);
    expect(state.builds[0]).toMatchObject({
      projectId: 'p1',
      commitSha: 'a'.repeat(40),
      commitMessage: 'feat: ship it',
      commitAuthor: 'Octo Cat',
      branch: 'main',
      status: 'QUEUED',
    });
    expect(state.webhookEvents.has('delivery-1')).toBe(true);
  });

  it('rejects an invalid signature with 401 and creates no build', async () => {
    const body = pushPayload();
    const app = createApp();
    const res = await supertest(app)
      .post('/api/webhooks/github')
      .set('Content-Type', 'application/json')
      .set('X-GitHub-Event', 'push')
      .set('X-GitHub-Delivery', 'delivery-bad')
      .set('X-Hub-Signature-256', sign(body, 'wrong-secret'))
      .send(body);

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: 'INVALID_SIGNATURE' });
    expect(state.builds).toHaveLength(0);
    expect(state.webhookEvents.size).toBe(0);
  });

  it('returns 204 and creates no build when the ref is not the tracked branch', async () => {
    const body = pushPayload({ ref: 'refs/heads/feature-x' });
    const app = createApp();
    const res = await supertest(app)
      .post('/api/webhooks/github')
      .set('Content-Type', 'application/json')
      .set('X-GitHub-Event', 'push')
      .set('X-GitHub-Delivery', 'delivery-feature')
      .set('X-Hub-Signature-256', sign(body))
      .send(body);

    expect(res.status).toBe(204);
    expect(res.body).toEqual({});
    expect(state.builds).toHaveLength(0);
    expect(state.webhookEvents.size).toBe(0);
  });

  it('treats a duplicate X-GitHub-Delivery as a no-op and returns 200', async () => {
    const body = pushPayload();
    const app = createApp();
    const first = await supertest(app)
      .post('/api/webhooks/github')
      .set('Content-Type', 'application/json')
      .set('X-GitHub-Event', 'push')
      .set('X-GitHub-Delivery', 'delivery-dup')
      .set('X-Hub-Signature-256', sign(body))
      .send(body);
    expect(first.status).toBe(202);
    expect(state.builds).toHaveLength(1);

    const second = await supertest(app)
      .post('/api/webhooks/github')
      .set('Content-Type', 'application/json')
      .set('X-GitHub-Event', 'push')
      .set('X-GitHub-Delivery', 'delivery-dup')
      .set('X-Hub-Signature-256', sign(body))
      .send(body);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ ok: true, duplicate: true });
    expect(state.builds).toHaveLength(1);
  });

  it('responds 200 { ok: true } to a ping event without creating a build', async () => {
    const body = JSON.stringify({ zen: 'hi', repository: { id: 12345 } });
    const app = createApp();
    const res = await supertest(app)
      .post('/api/webhooks/github')
      .set('Content-Type', 'application/json')
      .set('X-GitHub-Event', 'ping')
      .set('X-GitHub-Delivery', 'delivery-ping')
      .set('X-Hub-Signature-256', sign(body))
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(state.builds).toHaveLength(0);
    expect(state.webhookEvents.size).toBe(0);
  });

  it('refuses a valid signed push with 503 + Retry-After when KILL_SWITCH is on, creating no build', async () => {
    // `env` is read at import, so re-import the app with the switch flipped on.
    // The hoisted `vi.mock` factories re-apply to the freshly-imported modules.
    const prev = process.env.KILL_SWITCH;
    process.env.KILL_SWITCH = 'true';
    vi.resetModules();
    try {
      const { createApp: createKilledApp } = await import('../app.js');
      const body = pushPayload();
      const res = await supertest(createKilledApp())
        .post('/api/webhooks/github')
        .set('Content-Type', 'application/json')
        .set('X-GitHub-Event', 'push')
        .set('X-GitHub-Delivery', 'delivery-killed')
        .set('X-Hub-Signature-256', sign(body))
        .send(body);

      expect(res.status).toBe(503);
      expect(res.headers['retry-after']).toBe('86400');
      expect(res.body).toMatchObject({ error: 'BUILDS_PAUSED' });
      expect(state.builds).toHaveLength(0);
      expect(state.webhookEvents.size).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.KILL_SWITCH;
      else process.env.KILL_SWITCH = prev;
      vi.resetModules();
    }
  });

  it('returns 204 for an unrecognized event type', async () => {
    const body = JSON.stringify({ repository: { id: 12345 } });
    const app = createApp();
    const res = await supertest(app)
      .post('/api/webhooks/github')
      .set('Content-Type', 'application/json')
      .set('X-GitHub-Event', 'issues')
      .set('X-GitHub-Delivery', 'delivery-issues')
      .set('X-Hub-Signature-256', sign(body))
      .send(body);

    expect(res.status).toBe(204);
    expect(res.body).toEqual({});
    expect(state.builds).toHaveLength(0);
    expect(state.webhookEvents.size).toBe(0);
  });
});
