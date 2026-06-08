// M9 — central CSRF guard. `requireXRequestedWith` is applied CENTRALLY in
// app.ts at the router-group level for the cookie/session-authenticated routers
// (projects/github/builds/deployments/activity/account + auth), and is
// DELIBERATELY NOT applied to the token-authenticated `/api/admin` self-deploy
// router nor the HMAC-authenticated `/api/webhooks` receiver (the CI GitHub
// Action and GitHub itself never send `X-Requested-With`).
//
// This file exercises the central wiring end-to-end through the real
// `createApp()` mount chain, in one place, so a regression that drops the guard
// from the cookie routers OR wrongly adds it to admin/webhooks is caught here.
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
process.env.DEPLOY_TOKEN = 'super-secret-deploy-token-1234567890';

import { createHmac } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { encrypt } from '../lib/crypto.js';

const WEBHOOK_SECRET = 'super-secret-webhook-key';

const mocks = vi.hoisted(() => ({
  // account (cookie-auth) — POST /api/account/disconnect-github touches these
  projectCount: vi.fn(),
  userUpdate: vi.fn(),
  // webhook (HMAC-auth)
  projectFindFirst: vi.fn(),
  webhookEventCreate: vi.fn(),
  buildCreate: vi.fn(),
  transaction: vi.fn(),
  // admin (token-auth)
  rollPlatformApp: vi.fn(),
}));

vi.mock('../db.js', () => {
  const tx = {
    webhookEvent: { create: mocks.webhookEventCreate },
    build: { create: mocks.buildCreate },
  };
  return {
    prisma: {
      user: { update: mocks.userUpdate },
      project: { findFirst: mocks.projectFindFirst, count: mocks.projectCount },
      webhookEvent: { create: mocks.webhookEventCreate },
      build: { create: mocks.buildCreate },
      $transaction: mocks.transaction.mockImplementation(
        async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
      ),
    },
  };
});

// Cookie-auth: stub requireAuth so the account router runs with a fixed user.
vi.mock('../middleware/requireAuth.js', () => ({
  requireAuth: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { id: 'u1', githubLogin: 'octocat', email: null, avatarUrl: null };
    next();
  },
}));

vi.mock('./auth.js', async () => {
  const express = await import('express');
  return { default: express.Router() };
});

vi.mock('../services/azure/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/azure/index.js')>();
  return {
    ...actual,
    rollPlatformApp: mocks.rollPlatformApp,
    createContainerApp: vi.fn(),
    updateContainerApp: vi.fn(),
    deleteContainerApp: vi.fn(),
  };
});

const projectRow = (() => {
  const enc = encrypt(WEBHOOK_SECRET);
  return {
    id: 'p1',
    userId: 'u1',
    githubRepoId: 12345,
    branch: 'main',
    webhookSecretCiphertext: enc.ciphertext,
    webhookSecretIv: enc.iv,
    webhookSecretAuthTag: enc.authTag,
    webhookSecretKeyVersion: enc.keyVersion,
    autoDeploy: true,
    deletedAt: null as Date | null,
  };
})();

const { createApp } = await import('../app.js');
const supertest = (await import('supertest')).default;

const DEPLOY_TOKEN = 'super-secret-deploy-token-1234567890';
const API_IMAGE = 'prodstack.azurecr.io/prodstack-api:abc123';

function sign(body: string): string {
  return `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')}`;
}

function webhookPush(): string {
  return JSON.stringify({
    ref: 'refs/heads/main',
    repository: { id: 12345 },
    head_commit: { id: 'a'.repeat(40), message: 'ship', author: { name: 'Octo' } },
  });
}

beforeEach(() => {
  mocks.projectCount.mockReset();
  mocks.userUpdate.mockReset();
  mocks.projectFindFirst.mockReset();
  mocks.webhookEventCreate.mockReset();
  mocks.buildCreate.mockReset();
  mocks.rollPlatformApp.mockReset();

  // account/disconnect-github: no active projects (so it proceeds to clear the
  // token columns) and the update succeeds.
  mocks.projectCount.mockResolvedValue(0);
  mocks.userUpdate.mockResolvedValue({ id: 'u1' });

  // webhook happy path
  mocks.projectFindFirst.mockResolvedValue({ ...projectRow });
  mocks.webhookEventCreate.mockResolvedValue({ id: 'd', projectId: 'p1', receivedAt: new Date() });
  mocks.buildCreate.mockResolvedValue({ id: 'b1' });

  // admin deploy happy path
  mocks.rollPlatformApp.mockResolvedValue({
    name: 'prodstack-api',
    liveUrl: 'https://prodstack-api.example/',
    revisionName: 'prodstack-api--abc123',
  });
});

afterEach(() => vi.clearAllMocks());

describe('M9 central CSRF guard', () => {
  describe('cookie/session-authenticated mutating route (/api/account)', () => {
    it('REJECTS a mutating POST missing X-Requested-With with 403 CSRF', async () => {
      const res = await supertest(createApp()).post('/api/account/disconnect-github');
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: 'CSRF' });
      // Guard runs before the handler — no DB write happened.
      expect(mocks.userUpdate).not.toHaveBeenCalled();
    });

    it('ACCEPTS the same POST when X-Requested-With: XMLHttpRequest is present', async () => {
      const res = await supertest(createApp())
        .post('/api/account/disconnect-github')
        .set('X-Requested-With', 'XMLHttpRequest');
      expect(res.status).toBe(204);
      expect(mocks.userUpdate).toHaveBeenCalled();
    });
  });

  describe('token-authenticated route (/api/admin/deploy) is EXEMPT', () => {
    it('rolls WITHOUT X-Requested-With (CI runner sends no such header)', async () => {
      const res = await supertest(createApp())
        .post('/api/admin/deploy')
        .set('Content-Type', 'application/json')
        .set('X-Deploy-Token', DEPLOY_TOKEN)
        .send({ app: 'api', image: API_IMAGE });
      // 202 — proves the central CSRF guard did NOT intercept the admin router.
      expect(res.status).toBe(202);
      expect(mocks.rollPlatformApp).toHaveBeenCalledWith({ name: 'prodstack-api', image: API_IMAGE });
    });
  });

  describe('HMAC-authenticated webhook (/api/webhooks/github) is EXEMPT', () => {
    it('accepts a valid signed push WITHOUT X-Requested-With', async () => {
      const body = webhookPush();
      const res = await supertest(createApp())
        .post('/api/webhooks/github')
        .set('Content-Type', 'application/json')
        .set('X-GitHub-Event', 'push')
        .set('X-GitHub-Delivery', 'csrf-exempt-1')
        .set('X-Hub-Signature-256', sign(body))
        .send(body);
      // 202 — proves the central CSRF guard did NOT intercept the webhook router.
      expect(res.status).toBe(202);
      expect(res.body).toEqual({ buildId: 'b1' });
    });
  });
});
