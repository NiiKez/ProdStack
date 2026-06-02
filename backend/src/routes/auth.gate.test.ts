// Owner allow-list gate (single-user demo).
// `OWNER_GITHUB_ID` is read once at env load, so it must be set before the app
// is imported — this file pins it to 123 and exercises both sides of the gate.
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
process.env.OWNER_GITHUB_ID = '123';
// supertest's cookie-jar agent runs over plain HTTP and won't resend a
// `Secure` cookie — which is the default outside NODE_ENV=development. Force
// it off so the signed `oauth_state` cookie round-trips between begin+callback.
process.env.COOKIE_SECURE = 'false';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  exchangeCodeForToken: vi.fn(),
  fetchGithubProfile: vi.fn(),
  userUpsert: vi.fn(),
}));

vi.mock('../services/github.js', () => ({
  exchangeCodeForToken: mocks.exchangeCodeForToken,
  fetchGithubProfile: mocks.fetchGithubProfile,
}));

vi.mock('../db.js', () => ({
  prisma: { user: { upsert: mocks.userUpsert } },
}));

const { createApp } = await import('../app.js');
const supertest = (await import('supertest')).default;

async function completeCallback(profileId: number) {
  mocks.exchangeCodeForToken.mockResolvedValue({ accessToken: 'gho_token' });
  mocks.fetchGithubProfile.mockResolvedValue({
    id: profileId,
    login: 'someone',
    email: null,
    avatarUrl: null,
  });
  mocks.userUpsert.mockResolvedValue({ id: 'user-1' });

  const agent = supertest.agent(createApp());
  const begin = await agent.get('/api/auth/github/begin');
  const state = new URL(begin.headers.location as string).searchParams.get('state')!;
  return agent.get(`/api/auth/github/callback?code=valid&state=${state}`);
}

describe('OWNER_GITHUB_ID gate', () => {
  beforeEach(() => {
    mocks.exchangeCodeForToken.mockReset();
    mocks.fetchGithubProfile.mockReset();
    mocks.userUpsert.mockReset();
  });
  afterEach(() => vi.clearAllMocks());

  it('lets the owner through and mints a session', async () => {
    const res = await completeCallback(123);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('http://localhost:5173/dashboard');
    expect(mocks.userUpsert).toHaveBeenCalledTimes(1);
    const setCookie = res.headers['set-cookie'];
    expect(Array.isArray(setCookie) ? setCookie.join(';') : setCookie).toContain('session');
  });

  it('bounces a non-owner without persisting their token', async () => {
    const res = await completeCallback(999);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('http://localhost:5173/?denied=not_owner');
    // Critical: a rejected user's OAuth token is never written to the DB.
    expect(mocks.userUpsert).not.toHaveBeenCalled();
  });
});
