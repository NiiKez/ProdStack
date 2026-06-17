// Env must be set before importing the module under test (env.ts validates at
// module load). Mirrors the env-before-import pattern across the suite.
process.env.NODE_ENV = 'test';
process.env.WEB_ORIGIN = 'http://localhost:5173';
process.env.PUBLIC_API_URL = 'http://localhost:3000';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.JWT_SECRET = 'test-jwt-secret-test-jwt-secret-test-jwt-secret';
process.env.COOKIE_SECRET = 'test-cookie-secret-0123456789-abcdefghij';
process.env.DATA_ENC_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.GITHUB_OAUTH_CLIENT_ID = 'test-client-id';
process.env.GITHUB_OAUTH_CLIENT_SECRET = 'test-client-secret';
process.env.GITHUB_OAUTH_CALLBACK_URL = 'http://localhost:3000/api/auth/github/callback';
process.env.AZURE_STUB = 'true';
process.env.LOG_LEVEL = 'silent';
// Default cap (5) is what env.ts uses; the cap test relies on it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  // transaction-scoped (tx.*)
  txWebhookEventCreate: vi.fn(),
  txPreviewFindFirst: vi.fn(),
  txPreviewCount: vi.fn(),
  txPreviewCreate: vi.fn(),
  txPreviewUpdate: vi.fn(),
  txBuildCreate: vi.fn(),
  // top-level prisma.*
  previewFindUnique: vi.fn(),
  previewFindFirst: vi.fn(),
  previewUpdate: vi.fn(),
  previewUpdateMany: vi.fn(),
  previewFindMany: vi.fn(),
  transaction: vi.fn(),
  deleteContainerApp: vi.fn(),
}));

vi.mock('../../db.js', () => ({
  prisma: {
    previewEnvironment: {
      findUnique: mocks.previewFindUnique,
      findFirst: mocks.previewFindFirst,
      update: mocks.previewUpdate,
      updateMany: mocks.previewUpdateMany,
      findMany: mocks.previewFindMany,
    },
    $transaction: mocks.transaction,
  },
}));

vi.mock('../azure/index.js', () => ({ deleteContainerApp: mocks.deleteContainerApp }));

const {
  isTrustedPullRequest,
  upsertPreviewAndEnqueueBuild,
  teardownPreview,
  teardownPreviewByPr,
  markPreviewFailedIfPending,
  listPreviews,
} = await import('./previewService.js');

const basePr = {
  prNumber: 42,
  title: 'Add feature',
  headRef: 'feature-x',
  headSha: 'a'.repeat(40),
  authorLogin: 'octocat',
  authorAssociation: 'OWNER',
  isFork: false,
};

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  const tx = {
    webhookEvent: { create: mocks.txWebhookEventCreate },
    previewEnvironment: {
      findFirst: mocks.txPreviewFindFirst,
      count: mocks.txPreviewCount,
      create: mocks.txPreviewCreate,
      update: mocks.txPreviewUpdate,
    },
    build: { create: mocks.txBuildCreate },
  };
  mocks.transaction.mockImplementation(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx));
  // sensible defaults
  mocks.txWebhookEventCreate.mockResolvedValue({});
  mocks.txPreviewFindFirst.mockResolvedValue(null);
  mocks.txPreviewCount.mockResolvedValue(0);
  mocks.txPreviewCreate.mockResolvedValue({ id: 'pv1' });
  mocks.txPreviewUpdate.mockResolvedValue({ id: 'pv1' });
  mocks.txBuildCreate.mockResolvedValue({ id: 'b1' });
  mocks.deleteContainerApp.mockResolvedValue(undefined);
});

afterEach(() => vi.clearAllMocks());

describe('isTrustedPullRequest', () => {
  it('trusts OWNER/MEMBER/COLLABORATOR on a non-fork PR', () => {
    for (const a of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
      expect(isTrustedPullRequest({ authorAssociation: a, isFork: false })).toBe(true);
    }
  });

  it('rejects external associations even on a non-fork PR', () => {
    for (const a of ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'NONE', 'MANNEQUIN']) {
      expect(isTrustedPullRequest({ authorAssociation: a, isFork: false })).toBe(false);
    }
  });

  it('rejects a fork even from a trusted association', () => {
    expect(isTrustedPullRequest({ authorAssociation: 'OWNER', isFork: true })).toBe(false);
  });
});

describe('upsertPreviewAndEnqueueBuild', () => {
  it('creates a new preview + a QUEUED preview build under the cap', async () => {
    const res = await upsertPreviewAndEnqueueBuild({ projectId: 'p1', deliveryId: 'd1', pr: basePr });

    expect(res).toEqual({ ok: true, previewId: 'pv1', buildId: 'b1', created: true });
    expect(mocks.txWebhookEventCreate).toHaveBeenCalledWith({ data: { id: 'd1', projectId: 'p1' } });
    expect(mocks.txPreviewCreate).toHaveBeenCalledTimes(1);
    // The build is created with previewId + PR head info, QUEUED + (not pre-claimed).
    const buildArg = mocks.txBuildCreate.mock.calls[0]![0].data;
    expect(buildArg).toMatchObject({
      projectId: 'p1',
      previewId: 'pv1',
      commitSha: 'a'.repeat(40),
      branch: 'feature-x',
      status: 'QUEUED',
    });
    expect(buildArg.claimedAt).toBeUndefined(); // claimable by the real worker
    // lastBuildId is linked back to the preview.
    expect(mocks.txPreviewUpdate).toHaveBeenCalledWith({
      where: { id: 'pv1' },
      data: { lastBuildId: 'b1' },
    });
  });

  it('reuses an existing open preview (created=false) and skips the cap check', async () => {
    mocks.txPreviewFindFirst.mockResolvedValue({ id: 'pv1' });
    const res = await upsertPreviewAndEnqueueBuild({ projectId: 'p1', deliveryId: 'd2', pr: basePr });

    expect(res).toMatchObject({ ok: true, created: false });
    expect(mocks.txPreviewCreate).not.toHaveBeenCalled();
    expect(mocks.txPreviewCount).not.toHaveBeenCalled(); // cap only checked for NEW previews
  });

  it('returns limit_reached (no build) when the per-project open cap is hit', async () => {
    mocks.txPreviewFindFirst.mockResolvedValue(null);
    mocks.txPreviewCount.mockResolvedValue(5); // == default PREVIEW_MAX_ACTIVE_PER_PROJECT

    const res = await upsertPreviewAndEnqueueBuild({ projectId: 'p1', deliveryId: 'd3', pr: basePr });

    expect(res).toEqual({ ok: false, reason: 'limit_reached' });
    expect(mocks.txPreviewCreate).not.toHaveBeenCalled();
    expect(mocks.txBuildCreate).not.toHaveBeenCalled();
  });

  it('returns duplicate on a P2002 from the delivery-id idempotency marker', async () => {
    const { Prisma } = await import('@prisma/client');
    mocks.txWebhookEventCreate.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' }),
    );

    const res = await upsertPreviewAndEnqueueBuild({ projectId: 'p1', deliveryId: 'd1', pr: basePr });

    expect(res).toEqual({ ok: false, reason: 'duplicate' });
    expect(mocks.txBuildCreate).not.toHaveBeenCalled();
  });
});

describe('teardownPreview', () => {
  it('deletes the Container App then marks TORN_DOWN + closedAt + clears liveUrl', async () => {
    mocks.previewFindUnique.mockResolvedValue({
      id: 'pv1',
      containerAppName: 'pr42-abcd1234',
      status: 'ACTIVE',
      closedAt: null,
    });

    await teardownPreview('pv1');

    expect(mocks.deleteContainerApp).toHaveBeenCalledWith('pr42-abcd1234');
    const arg = mocks.previewUpdate.mock.calls[0]![0];
    expect(arg.where).toEqual({ id: 'pv1' });
    expect(arg.data.status).toBe('TORN_DOWN');
    expect(arg.data.liveUrl).toBeNull();
    expect(arg.data.closedAt).toBeInstanceOf(Date);
  });

  it('is idempotent: an already-torn-down preview does no Azure call or DB write', async () => {
    mocks.previewFindUnique.mockResolvedValue({
      id: 'pv1',
      containerAppName: 'pr42-abcd1234',
      status: 'TORN_DOWN',
      closedAt: new Date(),
    });

    await teardownPreview('pv1');

    expect(mocks.deleteContainerApp).not.toHaveBeenCalled();
    expect(mocks.previewUpdate).not.toHaveBeenCalled();
  });

  it('still flips the DB when the Azure delete fails (best-effort)', async () => {
    mocks.previewFindUnique.mockResolvedValue({
      id: 'pv1',
      containerAppName: 'pr42-abcd1234',
      status: 'ACTIVE',
      closedAt: null,
    });
    mocks.deleteContainerApp.mockRejectedValue(new Error('azure 404'));

    await teardownPreview('pv1');

    expect(mocks.previewUpdate).toHaveBeenCalledTimes(1);
  });

  it('no-ops for a missing preview', async () => {
    mocks.previewFindUnique.mockResolvedValue(null);
    await teardownPreview('missing');
    expect(mocks.deleteContainerApp).not.toHaveBeenCalled();
    expect(mocks.previewUpdate).not.toHaveBeenCalled();
  });
});

describe('teardownPreviewByPr', () => {
  it('tears down the open preview for a PR and returns true', async () => {
    mocks.previewFindFirst.mockResolvedValue({ id: 'pv1' });
    mocks.previewFindUnique.mockResolvedValue({
      id: 'pv1',
      containerAppName: 'pr42-abcd1234',
      status: 'ACTIVE',
      closedAt: null,
    });

    const found = await teardownPreviewByPr('p1', 42);

    expect(found).toBe(true);
    expect(mocks.previewFindFirst).toHaveBeenCalledWith({
      where: { projectId: 'p1', prNumber: 42, closedAt: null },
    });
    expect(mocks.deleteContainerApp).toHaveBeenCalledTimes(1);
  });

  it('returns false when there is no open preview for the PR', async () => {
    mocks.previewFindFirst.mockResolvedValue(null);
    const found = await teardownPreviewByPr('p1', 99);
    expect(found).toBe(false);
    expect(mocks.deleteContainerApp).not.toHaveBeenCalled();
  });
});

describe('markPreviewFailedIfPending', () => {
  it('only flips a preview that is still PENDING', async () => {
    await markPreviewFailedIfPending('pv1');
    expect(mocks.previewUpdateMany).toHaveBeenCalledWith({
      where: { id: 'pv1', status: 'PENDING' },
      data: { status: 'FAILED' },
    });
  });
});

describe('listPreviews', () => {
  it('lists a project\'s previews newest-first', async () => {
    mocks.previewFindMany.mockResolvedValue([{ id: 'pv1' }]);
    const rows = await listPreviews('p1');
    expect(rows).toEqual([{ id: 'pv1' }]);
    const arg = mocks.previewFindMany.mock.calls[0]![0];
    expect(arg.where).toEqual({ projectId: 'p1' });
    expect(arg.orderBy).toEqual({ createdAt: 'desc' });
  });
});
