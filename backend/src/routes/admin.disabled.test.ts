// Companion to admin.test.ts: proves the self-deploy endpoint is INERT when
// `DEPLOY_TOKEN` is unset (the safe default for local dev / a self-hosted fork).
// `env` reads the token once at module load, so we must clear it before the app
// imports — and explicitly, because process.env is shared across test files in a
// worker and admin.test.ts sets it.
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
delete process.env.DEPLOY_TOKEN;

import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rollPlatformApp: vi.fn() }));
vi.mock('../services/azure/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/azure/index.js')>();
  return { ...actual, rollPlatformApp: mocks.rollPlatformApp };
});

const { createApp } = await import('../app.js');
const supertest = (await import('supertest')).default;

describe('POST /api/admin/deploy with DEPLOY_TOKEN unset', () => {
  it('is a no-op returning 503 DEPLOY_DISABLED, even with a token header', async () => {
    const res = await supertest(createApp())
      .post('/api/admin/deploy')
      .set('Content-Type', 'application/json')
      .set('X-Deploy-Token', 'anything')
      .send({ app: 'api', image: 'prodstack.azurecr.io/prodstack-api:abc' });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('DEPLOY_DISABLED');
    expect(mocks.rollPlatformApp).not.toHaveBeenCalled();
  });
});
