// Self-deploy endpoint (M6 "Option B"). `DEPLOY_TOKEN` is read once at env load,
// so it must be set before the app is imported — this file pins it and exercises
// the token gate, app allow-list, and registry pin. A separate describe block
// re-imports with the token UNSET to prove the 503 no-op default.
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
process.env.DEPLOY_TOKEN = 'super-secret-deploy-token-1234567890';
process.env.ADMIN_TOKEN = 'super-secret-admin-token-1234567890';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rollPlatformApp: vi.fn(),
  cleanupImages: vi.fn(),
  cleanupBuilds: vi.fn(),
}));

// Keep the real PLATFORM_APPS map (the route indexes into it) but stub the SDK
// call so no Azure round-trip happens.
vi.mock('../services/azure/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/azure/index.js')>();
  return { ...actual, rollPlatformApp: mocks.rollPlatformApp };
});

// Stub the cleanup services so the endpoint tests never touch ACR / Postgres.
vi.mock('../services/cleanup/cleanupImages.js', () => ({
  cleanupImages: mocks.cleanupImages,
}));
vi.mock('../services/cleanup/cleanupBuilds.js', () => ({
  cleanupBuilds: mocks.cleanupBuilds,
}));

const { createApp } = await import('../app.js');
const supertest = (await import('supertest')).default;

const TOKEN = 'super-secret-deploy-token-1234567890';
const ADMIN_TOKEN = 'super-secret-admin-token-1234567890';
const API_IMAGE = 'prodstack.azurecr.io/prodstack-api:abc123';
const WEB_IMAGE = 'prodstack.azurecr.io/prodstack-web:abc123';

function post(body: unknown, token?: string) {
  const req = supertest(createApp())
    .post('/api/admin/deploy')
    .set('Content-Type', 'application/json');
  if (token !== undefined) req.set('X-Deploy-Token', token);
  return req.send(body as object);
}

describe('POST /api/admin/deploy', () => {
  beforeEach(() => {
    mocks.rollPlatformApp.mockReset();
    mocks.rollPlatformApp.mockResolvedValue({
      name: 'prodstack-api',
      liveUrl: 'https://prodstack-api.example/',
      revisionName: 'prodstack-api--abc123',
    });
  });
  afterEach(() => vi.clearAllMocks());

  it('rolls the API app on a valid token + image (202)', async () => {
    const res = await post({ app: 'api', image: API_IMAGE }, TOKEN);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ rolled: true, app: 'api', name: 'prodstack-api', image: API_IMAGE });
    expect(mocks.rollPlatformApp).toHaveBeenCalledWith({ name: 'prodstack-api', image: API_IMAGE });
  });

  it('rolls the web app and maps app->container name', async () => {
    mocks.rollPlatformApp.mockResolvedValue({ name: 'prodstack-web', liveUrl: 'x' });
    const res = await post({ app: 'web', image: WEB_IMAGE }, TOKEN);
    expect(res.status).toBe(202);
    expect(mocks.rollPlatformApp).toHaveBeenCalledWith({ name: 'prodstack-web', image: WEB_IMAGE });
  });

  it('rejects a missing token (401) without rolling', async () => {
    const res = await post({ app: 'api', image: API_IMAGE });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHORIZED');
    expect(mocks.rollPlatformApp).not.toHaveBeenCalled();
  });

  it('rejects a wrong token (401) without rolling', async () => {
    const res = await post({ app: 'api', image: API_IMAGE }, 'wrong-token-wrong-token-wrong-token');
    expect(res.status).toBe(401);
    expect(mocks.rollPlatformApp).not.toHaveBeenCalled();
  });

  it('rejects an unknown app value (400)', async () => {
    const res = await post({ app: 'builder', image: 'prodstack.azurecr.io/prodstack-builder:x' }, TOKEN);
    expect(res.status).toBe(400);
    expect(mocks.rollPlatformApp).not.toHaveBeenCalled();
  });

  it('rejects an image outside our ACR (400)', async () => {
    const res = await post({ app: 'api', image: 'evil.example.com/prodstack-api:abc123' }, TOKEN);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_IMAGE');
    expect(mocks.rollPlatformApp).not.toHaveBeenCalled();
  });

  it('rejects an image for the wrong repository (400) — api token, web image', async () => {
    const res = await post({ app: 'api', image: WEB_IMAGE }, TOKEN);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_IMAGE');
    expect(mocks.rollPlatformApp).not.toHaveBeenCalled();
  });

  it('rejects an image with no tag (400)', async () => {
    const res = await post({ app: 'api', image: 'prodstack.azurecr.io/prodstack-api:' }, TOKEN);
    expect(res.status).toBe(400);
    expect(mocks.rollPlatformApp).not.toHaveBeenCalled();
  });

  // The startsWith pin used to let these through: a `@sha256:` digest or extra
  // path segments after a cosmetic `:tag` would pull a DIFFERENT manifest from
  // our own ACR (e.g. the prodstack-builder image). The strict tag regex blocks
  // every form below.
  it.each([
    ['digest after a cosmetic tag', 'prodstack.azurecr.io/prodstack-api:x@sha256:abc123'],
    ['bare digest', 'prodstack.azurecr.io/prodstack-api@sha256:abc123'],
    ['path traversal in the tag', 'prodstack.azurecr.io/prodstack-api:tag/../../evil'],
    ['extra path segment', 'prodstack.azurecr.io/prodstack-api:a/b'],
    ['whitespace in the tag', 'prodstack.azurecr.io/prodstack-api:tag with space'],
    ['newline in the tag', 'prodstack.azurecr.io/prodstack-api:tag\nDELETE'],
    ['nested repo path', 'prodstack.azurecr.io/prodstack-api/extra:tag'],
    ['uppercase registry host', 'PRODSTACK.azurecr.io/prodstack-api:tag'],
  ])('rejects image-ref bypass attempt: %s (400)', async (_label, image) => {
    const res = await post({ app: 'api', image }, TOKEN);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_IMAGE');
    expect(mocks.rollPlatformApp).not.toHaveBeenCalled();
  });
});

// --- Cost-safeguard cleanup endpoints (M6 §2.14) ---------------------------

function postCleanup(path: 'images' | 'builds', body: unknown, token?: string) {
  const req = supertest(createApp())
    .post(`/api/admin/cleanup/${path}`)
    .set('Content-Type', 'application/json');
  if (token !== undefined) req.set('X-Admin-Token', token);
  return req.send((body ?? {}) as object);
}

describe('POST /api/admin/cleanup/images', () => {
  beforeEach(() => {
    mocks.cleanupImages.mockReset().mockResolvedValue({
      scanned: 10,
      deleted: 3,
      kept: 7,
      perRepo: [{ repo: 'proj-app', deleted: 3, kept: 7 }],
    });
  });
  afterEach(() => vi.clearAllMocks());

  it('runs image GC on a valid admin token (200 + summary)', async () => {
    const res = await postCleanup('images', {}, ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ scanned: 10, deleted: 3, kept: 7 });
    expect(mocks.cleanupImages).toHaveBeenCalledWith({ dryRun: undefined });
  });

  it('passes through dryRun', async () => {
    const res = await postCleanup('images', { dryRun: true }, ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(mocks.cleanupImages).toHaveBeenCalledWith({ dryRun: true });
  });

  it('rejects a missing token (401) without running', async () => {
    const res = await postCleanup('images', {});
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHORIZED');
    expect(mocks.cleanupImages).not.toHaveBeenCalled();
  });

  it('rejects a wrong token (401) without running', async () => {
    const res = await postCleanup('images', {}, 'wrong-admin-token-wrong-admin-token');
    expect(res.status).toBe(401);
    expect(mocks.cleanupImages).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/cleanup/builds', () => {
  beforeEach(() => {
    mocks.cleanupBuilds.mockReset().mockResolvedValue({
      logLinesDeleted: 42,
      buildsDeleted: 5,
    });
  });
  afterEach(() => vi.clearAllMocks());

  it('prunes builds/logs on a valid admin token (200 + counts)', async () => {
    const res = await postCleanup('builds', {}, ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ logLinesDeleted: 42, buildsDeleted: 5 });
    expect(mocks.cleanupBuilds).toHaveBeenCalledTimes(1);
  });

  it('rejects a missing token (401) without running', async () => {
    const res = await postCleanup('builds', {});
    expect(res.status).toBe(401);
    expect(mocks.cleanupBuilds).not.toHaveBeenCalled();
  });
});

// Companion to admin.disabled.test.ts: prove the cleanup endpoints are INERT
// (503 CLEANUP_DISABLED) when ADMIN_TOKEN is unset. env reads the token once at
// module load, so we re-import the app under a fresh module graph with the var
// cleared (vi.resetModules + dynamic import), then restore.
describe('cleanup endpoints with ADMIN_TOKEN unset', () => {
  it('returns 503 CLEANUP_DISABLED even with a token header', async () => {
    const saved = process.env.ADMIN_TOKEN;
    delete process.env.ADMIN_TOKEN;
    vi.resetModules();
    vi.doMock('../services/cleanup/cleanupImages.js', () => ({ cleanupImages: vi.fn() }));
    vi.doMock('../services/cleanup/cleanupBuilds.js', () => ({ cleanupBuilds: vi.fn() }));
    try {
      const { createApp: freshCreateApp } = await import('../app.js');
      const st = (await import('supertest')).default;
      const res = await st(freshCreateApp())
        .post('/api/admin/cleanup/images')
        .set('Content-Type', 'application/json')
        .set('X-Admin-Token', 'anything-at-all-1234567890')
        .send({});
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('CLEANUP_DISABLED');
    } finally {
      vi.doUnmock('../services/cleanup/cleanupImages.js');
      vi.doUnmock('../services/cleanup/cleanupBuilds.js');
      if (saved !== undefined) process.env.ADMIN_TOKEN = saved;
      vi.resetModules();
    }
  });
});
