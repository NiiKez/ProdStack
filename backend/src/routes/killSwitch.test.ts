// Kill switch (degrade mode) behaviour. `env.KILL_SWITCH` is read once when
// `env.ts` is imported, so it must be set BEFORE the app module is imported —
// this file pins it true and then dynamic-imports the app. (The default-off
// webhook behaviour lives in `webhooks.test.ts`, which imports the app with
// the switch off.)
process.env.NODE_ENV = 'test';
process.env.WEB_ORIGIN = 'http://localhost:5173';
process.env.PUBLIC_API_URL = 'http://localhost:3000';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.JWT_SECRET = 'test-jwt-secret-test-jwt-secret-0123456789';
process.env.COOKIE_SECRET = 'test-cookie-secret-0123456789-abcdefghij';
process.env.DATA_ENC_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.GITHUB_OAUTH_CLIENT_ID = 'test-client-id';
process.env.GITHUB_OAUTH_CLIENT_SECRET = 'test-client-secret';
process.env.GITHUB_OAUTH_CALLBACK_URL = 'http://localhost:3000/api/auth/github/callback';
process.env.AZURE_STUB = 'true';
process.env.LOG_LEVEL = 'silent';
process.env.KILL_SWITCH = 'true';

import { createHmac } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { encrypt } from '../lib/crypto.js';

const WEBHOOK_SECRET = 'super-secret-webhook-key';

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
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('kill switch (degrade mode) with KILL_SWITCH=true', () => {
  it('GET /api/health reports killSwitch: true', async () => {
    const res = await supertest(createApp()).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', killSwitch: true });
  });

  it('refuses a valid signed push with 503 + Retry-After and creates no build', async () => {
    const body = pushPayload();
    const res = await supertest(createApp())
      .post('/api/webhooks/github')
      .set('Content-Type', 'application/json')
      .set('X-GitHub-Event', 'push')
      .set('X-GitHub-Delivery', 'delivery-killed')
      .set('X-Hub-Signature-256', sign(body))
      .send(body);

    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('86400');
    expect(res.body).toMatchObject({ error: 'BUILDS_PAUSED' });
    // No idempotency row and no Build were written.
    expect(mocks.webhookEventCreate).not.toHaveBeenCalled();
    expect(mocks.buildCreate).not.toHaveBeenCalled();
  });

  it('still verifies the signature before refusing (bad signature → 401, not 503)', async () => {
    const body = pushPayload();
    const res = await supertest(createApp())
      .post('/api/webhooks/github')
      .set('Content-Type', 'application/json')
      .set('X-GitHub-Event', 'push')
      .set('X-GitHub-Delivery', 'delivery-killed-bad')
      .set('X-Hub-Signature-256', sign(body, 'wrong-secret'))
      .send(body);

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: 'INVALID_SIGNATURE' });
  });

  it('still answers a ping with 200 even while paused', async () => {
    const body = JSON.stringify({ zen: 'hi', repository: { id: 12345 } });
    const res = await supertest(createApp())
      .post('/api/webhooks/github')
      .set('Content-Type', 'application/json')
      .set('X-GitHub-Event', 'ping')
      .set('X-GitHub-Delivery', 'delivery-killed-ping')
      .set('X-Hub-Signature-256', sign(body))
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
