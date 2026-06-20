// GET /api/account serialization under the PROD-shaped config (AZURE_STUB=false →
// managed-identity mode). me.test.ts only exercises the stub branch; this file
// locks the non-stub branch + that the subscription/resource-group are surfaced.
// NODE_ENV=test + AZURE_STUB=false is the allowed combination (the dev backdoor
// only mounts under development — see env.ts assertSafeEnvCombination).
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
process.env.AZURE_STUB = 'false';
process.env.AZURE_SUBSCRIPTION_ID = 'sub-1234';
process.env.AZURE_RESOURCE_GROUP = 'prodstack';
process.env.AZURE_REGION = 'francecentral';
process.env.LOG_LEVEL = 'silent';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  projectCount: vi.fn(),
}));

vi.mock('../db.js', () => ({
  prisma: {
    user: { findUnique: mocks.userFindUnique },
    project: { count: mocks.projectCount },
  },
}));

vi.mock('../middleware/requireAuth.js', () => ({
  requireAuth: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { id: 'u1', githubLogin: 'octocat', email: null, avatarUrl: null, isDemo: false };
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
  mocks.userFindUnique.mockReset();
  mocks.projectCount.mockReset();
  mocks.userFindUnique.mockResolvedValue({ githubTokenCiphertext: Buffer.from([1, 2, 3]) });
  mocks.projectCount.mockResolvedValue(0);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/account — managed-identity (AZURE_STUB=false)', () => {
  it('reports azure.mode=managed-identity and surfaces subscription/resource-group', async () => {
    const res = await supertest(createApp()).get('/api/account');
    expect(res.status).toBe(200);
    expect(res.body.azure).toEqual({
      mode: 'managed-identity',
      region: 'francecentral',
      subscriptionId: 'sub-1234',
      resourceGroup: 'prodstack',
    });
    // The encrypted token still never leaks, even on the prod-shaped path.
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toMatch(/githubToken/i);
    expect(serialized).not.toMatch(/ciphertext/i);
  });
});
