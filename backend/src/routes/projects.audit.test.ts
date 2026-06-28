// Audit-trail wiring for the project routes: an env-var change records an
// `env.updated` security event with the CHANGED KEYS ONLY (never values).
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

const state = vi.hoisted(() => ({ stubAuth: true }));

const mocks = vi.hoisted(() => ({
  projectFindFirst: vi.fn(),
  userFindUnique: vi.fn(),
  $transaction: vi.fn(),
  loadDecryptedEnvVars: vi.fn(),
  loadEnvVarMeta: vi.fn(),
  redeployWithCurrentEnv: vi.fn(),
  recordSecurityEvent: vi.fn(),
}));

vi.mock('../db.js', () => ({
  prisma: {
    project: { findFirst: mocks.projectFindFirst },
    user: { findUnique: mocks.userFindUnique },
    build: { findFirst: vi.fn() },
    $transaction: mocks.$transaction,
  },
}));

vi.mock('../services/securityEvents.js', () => ({
  recordSecurityEvent: mocks.recordSecurityEvent,
}));

vi.mock('../services/deploy.js', () => ({
  rollbackToDeployment: vi.fn(),
  redeployWithCurrentEnv: mocks.redeployWithCurrentEnv,
  IN_FLIGHT_BUILD_STATUSES: ['QUEUED', 'CLONING', 'BUILDING', 'PUSHING', 'DEPLOYING'],
}));

vi.mock('../services/projectEnv.js', () => ({
  loadDecryptedEnvVars: mocks.loadDecryptedEnvVars,
  loadEnvVarMeta: mocks.loadEnvVarMeta,
}));

vi.mock('../services/azure/index.js', () => ({
  createContainerApp: vi.fn(),
  updateContainerApp: vi.fn(),
  deleteContainerApp: vi.fn(),
}));

vi.mock('../middleware/requireAuth.js', () => ({
  requireAuth: (
    req: { user?: unknown },
    res: { status: (n: number) => { json: (b: unknown) => void } },
    next: () => void,
  ) => {
    if (state.stubAuth) {
      req.user = { id: 'u1', githubLogin: 'octocat', email: null, avatarUrl: null, isDemo: false };
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

const project = {
  id: 'p1',
  userId: 'u1',
  name: 'Hello',
  slug: 'hello',
  githubRepoFullName: 'octocat/hello',
  githubRepoId: 12345,
  branch: 'main',
  webhookId: 99,
  containerAppName: 'octocat-app',
  liveUrl: 'https://octocat-app.example.com',
  frameworkHint: null,
  createdAt: new Date('2026-05-31T09:00:00Z'),
  updatedAt: new Date('2026-05-31T09:00:00Z'),
  deletedAt: null,
};

function mockPatchTx() {
  mocks.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
    cb({
      project: {
        update: vi.fn(),
        findFirstOrThrow: vi.fn().mockResolvedValue({ ...project, builds: [], deployments: [] }),
      },
      envVar: { deleteMany: vi.fn(), upsert: vi.fn() },
    }),
  );
}

beforeEach(() => {
  state.stubAuth = true;
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.projectFindFirst.mockResolvedValue(project);
  mocks.userFindUnique.mockResolvedValue({ id: 'u1' });
  mocks.loadDecryptedEnvVars.mockResolvedValue([]);
  mocks.loadEnvVarMeta.mockResolvedValue([]);
  mocks.redeployWithCurrentEnv.mockResolvedValue({ redeployed: false });
  mocks.recordSecurityEvent.mockResolvedValue(undefined);
});

afterEach(() => vi.clearAllMocks());

describe('PATCH /api/projects/:id — env.updated audit event', () => {
  it('records env.updated with the changed KEYS only (added/edited/removed), never values', async () => {
    mockPatchTx();
    // KEEP is unchanged; EDIT changes value; REMOVE is dropped; NEW is added.
    mocks.loadDecryptedEnvVars.mockResolvedValue([
      { name: 'KEEP', value: 'keepval' },
      { name: 'EDIT', value: 'oldval' },
      { name: 'REMOVE', value: 'removeval' },
    ]);
    mocks.redeployWithCurrentEnv.mockResolvedValue({ redeployed: true });

    const res = await supertest(createApp())
      .patch('/api/projects/p1')
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({
        envVars: [
          { key: 'KEEP' }, // kept (no value)
          { key: 'EDIT', value: 'newval' }, // edited
          { key: 'NEWKEY', value: 'addedval' }, // added
          // REMOVE omitted → deleted
        ],
      });

    expect(res.status).toBe(200);
    expect(mocks.recordSecurityEvent).toHaveBeenCalledTimes(1);
    const call = mocks.recordSecurityEvent.mock.calls[0]![0]!;
    expect(call).toMatchObject({
      action: 'env.updated',
      outcome: 'success',
      userId: 'u1',
      targetType: 'project',
      targetId: 'p1',
    });
    // Changed keys only — sorted, KEEP excluded.
    expect(call.metadata).toEqual({ changedKeys: ['EDIT', 'NEWKEY', 'REMOVE'], count: 3 });

    // No env-var VALUE may appear anywhere in the recorded event.
    const serialized = JSON.stringify(call);
    for (const value of ['keepval', 'oldval', 'removeval', 'newval', 'addedval']) {
      expect(serialized).not.toContain(value);
    }
  });

  it('does NOT record env.updated on a no-op save (no keys changed)', async () => {
    mockPatchTx();
    mocks.loadDecryptedEnvVars.mockResolvedValue([{ name: 'API_KEY', value: 'secret' }]);

    const res = await supertest(createApp())
      .patch('/api/projects/p1')
      .set('X-Requested-With', 'XMLHttpRequest')
      // API_KEY kept (no value) → nothing changed.
      .send({ envVars: [{ key: 'API_KEY' }] });

    expect(res.status).toBe(200);
    expect(mocks.recordSecurityEvent).not.toHaveBeenCalled();
  });

  it('does NOT record env.updated for a metadata-only PATCH (no envVars submitted)', async () => {
    mockPatchTx();
    const res = await supertest(createApp())
      .patch('/api/projects/p1')
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({ name: 'Renamed' });

    expect(res.status).toBe(200);
    expect(mocks.recordSecurityEvent).not.toHaveBeenCalled();
  });
});
