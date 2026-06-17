// cleanupImages no-ops in stub mode and without ACR creds, so the test env runs
// with AZURE_STUB=false + ACR creds set. RETENTION_DAYS_IMAGES is read at module
// load — set it (and everything env.ts requires) before importing.
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
process.env.LOG_LEVEL = 'silent';
// Real-mode Azure so cleanupImages doesn't short-circuit. getContainerAppImage
// is mocked, so no Azure SDK call actually happens.
process.env.AZURE_STUB = 'false';
process.env.AZURE_SUBSCRIPTION_ID = 'sub-123';
process.env.AZURE_RESOURCE_GROUP = 'prodstack';
process.env.ACR_NAME = 'prodstack';
process.env.ACR_USERNAME = 'acr-user';
process.env.ACR_PASSWORD = 'acr-pass';
process.env.RETENTION_DAYS_IMAGES = '30';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listRepositories: vi.fn(),
  listTags: vi.fn(),
  deleteManifestByTag: vi.fn(),
  getContainerAppImage: vi.fn(),
  findManyDeployments: vi.fn(),
  findManyPreviews: vi.fn(),
  findManyBuilds: vi.fn(),
}));

vi.mock('./acrRegistry.js', () => ({
  hasAcrCredentials: () => true,
  listRepositories: mocks.listRepositories,
  listTags: mocks.listTags,
  deleteManifestByTag: mocks.deleteManifestByTag,
}));

vi.mock('../azure/containerApps.js', () => ({
  isStub: () => false,
  getContainerAppImage: mocks.getContainerAppImage,
}));

vi.mock('../../db.js', () => ({
  prisma: {
    deployment: { findMany: mocks.findManyDeployments },
    previewEnvironment: { findMany: mocks.findManyPreviews },
    build: { findMany: mocks.findManyBuilds },
  },
}));

const { cleanupImages, parseImageRef } = await import('./cleanupImages.js');

const HOST = 'prodstack.azurecr.io';
const DAY_MS = 24 * 60 * 60 * 1000;
const iso = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();

/** A tag fixture; digest defaults to a unique value derived from the name. */
function tag(name: string, ageDays: number, digest?: string) {
  return {
    name,
    digest: digest ?? `sha256:${name}`,
    lastUpdateTime: iso(ageDays * DAY_MS),
  };
}

describe('parseImageRef', () => {
  it('parses host/repo:tag', () => {
    expect(parseImageRef('prodstack.azurecr.io/prodstack-api:m6-rev1')).toEqual({
      repo: 'prodstack-api',
      tag: 'm6-rev1',
    });
  });
  it('returns null for a digest ref', () => {
    expect(parseImageRef('prodstack.azurecr.io/prodstack-api@sha256:abc')).toBeNull();
  });
  it('returns null when there is no tag', () => {
    expect(parseImageRef('prodstack.azurecr.io/prodstack-api')).toBeNull();
  });
  it('handles nested repo paths', () => {
    expect(parseImageRef('prodstack.azurecr.io/user/proj-app:v2')).toEqual({
      repo: 'user/proj-app',
      tag: 'v2',
    });
  });
});

describe('cleanupImages', () => {
  beforeEach(() => {
    mocks.listRepositories.mockReset();
    mocks.listTags.mockReset();
    mocks.deleteManifestByTag.mockReset().mockResolvedValue(undefined);
    mocks.getContainerAppImage.mockReset().mockResolvedValue(null);
    mocks.findManyDeployments.mockReset().mockResolvedValue([]);
    mocks.findManyPreviews.mockReset().mockResolvedValue([]);
    mocks.findManyBuilds.mockReset().mockResolvedValue([]);
  });
  afterEach(() => vi.clearAllMocks());

  it('keeps moving tags, recent tags, and newest-5; deletes old extras', async () => {
    mocks.listRepositories.mockResolvedValue(['proj-app']);
    // The newest-5 rule keeps the 5 most-recent tags BY TIME regardless of age.
    // Ordered newest→oldest here: recent(2d), old-a..old-c (the 3 next-newest)
    // round out the newest-5 → kept. latest/latest-success (200d) are kept by
    // the moving-tag rule. old-d/old-e/old-f are old AND outside newest-5 →
    // DELETE.
    mocks.listTags.mockResolvedValue([
      tag('latest', 200), // moving tag — kept despite age
      tag('latest-success', 200), // moving tag — kept despite age
      tag('recent', 2), // newer than 30d AND in newest-5 — kept
      tag('old-a', 100), // newest-5 (#2) — kept
      tag('old-b', 110), // newest-5 (#3) — kept
      tag('old-c', 120), // newest-5 (#4) — kept
      tag('old-d', 130), // outside newest-5 + old → DELETE
      tag('old-e', 140), // DELETE
      tag('old-f', 150), // DELETE
    ]);

    const res = await cleanupImages();

    // newest-5 by time = recent, old-a, old-b, old-c, old-d → all kept.
    // latest + latest-success kept by the moving-tag rule. Only old-e and old-f
    // are both old AND outside newest-5 → deleted.
    const deletedTags = mocks.deleteManifestByTag.mock.calls.map((c) => c[1]);
    expect(deletedTags.sort()).toEqual(['old-e', 'old-f']);
    expect(res.deleted).toBe(2);
    expect(res.perRepo).toEqual([{ repo: 'proj-app', deleted: 2, kept: 7 }]);
  });

  it('keeps a tag referenced by an active deployment even if old', async () => {
    mocks.findManyDeployments.mockResolvedValue([
      { build: { imageTag: `${HOST}/proj-app:pinned` } },
    ]);
    mocks.listRepositories.mockResolvedValue(['proj-app']);
    mocks.listTags.mockResolvedValue([
      tag('n1', 40),
      tag('n2', 45),
      tag('n3', 50),
      tag('n4', 55),
      tag('n5', 60),
      tag('pinned', 200), // old + outside newest-5, but active-deployment → KEEP
      tag('junk', 210), // old + unprotected → DELETE
    ]);

    await cleanupImages();
    const deletedTags = mocks.deleteManifestByTag.mock.calls.map((c) => c[1]);
    expect(deletedTags).toContain('junk');
    expect(deletedTags).not.toContain('pinned');
  });

  it('keeps the image of an open (PENDING/ACTIVE) preview even if old', async () => {
    // A preview's latest build image must survive GC while the preview is open,
    // else a live preview app becomes un-pullable on a replica restart.
    mocks.findManyPreviews.mockResolvedValue([{ lastBuildId: 'pb1' }]);
    mocks.findManyBuilds.mockResolvedValue([{ imageTag: `${HOST}/proj-app:pr-preview` }]);
    mocks.listRepositories.mockResolvedValue(['proj-app']);
    mocks.listTags.mockResolvedValue([
      tag('n1', 40),
      tag('n2', 45),
      tag('n3', 50),
      tag('n4', 55),
      tag('n5', 60),
      tag('pr-preview', 200), // old + outside newest-5, but open preview → KEEP
      tag('junk', 210), // old + unprotected → DELETE
    ]);

    await cleanupImages();
    // It queried only open (non-torn-down) previews with a build.
    const previewWhere = mocks.findManyPreviews.mock.calls[0]![0].where;
    expect(previewWhere.closedAt).toBeNull();
    const deletedTags = mocks.deleteManifestByTag.mock.calls.map((c) => c[1]);
    expect(deletedTags).toContain('junk');
    expect(deletedTags).not.toContain('pr-preview');
  });

  it('keeps the live platform image tag even if old', async () => {
    mocks.getContainerAppImage.mockImplementation(async (name: string) =>
      name === 'prodstack-api' ? `${HOST}/prodstack-api:m5-rev1` : null,
    );
    mocks.listRepositories.mockResolvedValue(['prodstack-api']);
    mocks.listTags.mockResolvedValue([
      tag('a', 40),
      tag('b', 45),
      tag('c', 50),
      tag('d', 55),
      tag('e', 60),
      tag('m5-rev1', 300), // live platform image — KEEP despite being very old
      tag('m4-rev1', 310), // old, unprotected → DELETE
    ]);

    await cleanupImages();
    const deletedTags = mocks.deleteManifestByTag.mock.calls.map((c) => c[1]);
    expect(deletedTags).toContain('m4-rev1');
    expect(deletedTags).not.toContain('m5-rev1');
  });

  it('dryRun deletes nothing but still reports the would-delete count', async () => {
    mocks.listRepositories.mockResolvedValue(['proj-app']);
    mocks.listTags.mockResolvedValue([
      tag('n1', 40),
      tag('n2', 45),
      tag('n3', 50),
      tag('n4', 55),
      tag('n5', 60),
      tag('dead', 200),
    ]);

    const res = await cleanupImages({ dryRun: true });
    expect(mocks.deleteManifestByTag).not.toHaveBeenCalled();
    expect(res.deleted).toBe(1);
  });

  it('de-dupes deletes that share a manifest digest', async () => {
    mocks.listRepositories.mockResolvedValue(['proj-app']);
    mocks.listTags.mockResolvedValue([
      tag('n1', 40),
      tag('n2', 45),
      tag('n3', 50),
      tag('n4', 55),
      tag('n5', 60),
      tag('twin-a', 200, 'sha256:shared'),
      tag('twin-b', 210, 'sha256:shared'),
    ]);

    const res = await cleanupImages();
    // Both old, both unprotected, same digest → only ONE manifest DELETE.
    expect(mocks.deleteManifestByTag).toHaveBeenCalledTimes(1);
    expect(res.deleted).toBe(2); // both counted as removed
  });

  it('protects a digest-pinned live platform image (no tag to protect)', async () => {
    // ACA echoes the API image back as a digest pin → parseImageRef returns null,
    // so the only protection is by digest. The old tag pointing at that manifest
    // must survive even though its NAME isn't in any keep-set.
    mocks.getContainerAppImage.mockImplementation(async (name: string) =>
      name === 'prodstack-api' ? `${HOST}/prodstack-api@sha256:livepin` : null,
    );
    mocks.listRepositories.mockResolvedValue(['prodstack-api']);
    mocks.listTags.mockResolvedValue([
      tag('n1', 40),
      tag('n2', 45),
      tag('n3', 50),
      tag('n4', 55),
      tag('n5', 60),
      tag('old-live', 200, 'sha256:livepin'), // manifest == live image → KEEP by digest
      tag('junk', 210), // old, unique digest, unprotected → DELETE
    ]);

    await cleanupImages();
    const deletedTags = mocks.deleteManifestByTag.mock.calls.map((c) => c[1]);
    expect(deletedTags).toContain('junk');
    expect(deletedTags).not.toContain('old-live');
  });

  it('protects a manifest across repos when a kept tag elsewhere shares its digest', async () => {
    mocks.listRepositories.mockResolvedValue(['repo-a', 'repo-b']);
    mocks.listTags.mockImplementation(async (repo: string) =>
      repo === 'repo-a'
        ? [
            tag('a1', 40),
            tag('a2', 45),
            tag('a3', 50),
            tag('a4', 55),
            tag('a5', 60),
            tag('keeper', 2, 'sha256:shared'), // recent → KEPT → protects sha256:shared
          ]
        : [
            tag('b1', 40),
            tag('b2', 45),
            tag('b3', 50),
            tag('b4', 55),
            tag('b5', 60),
            tag('old-twin', 200, 'sha256:shared'), // old here, but manifest is kept in repo-a
          ],
    );

    await cleanupImages();
    const deletedTags = mocks.deleteManifestByTag.mock.calls.map((c) => c[1]);
    expect(deletedTags).not.toContain('old-twin');
  });

  it('does not delete an old tag whose manifest is shared by a kept tag in the same repo', async () => {
    mocks.listRepositories.mockResolvedValue(['proj-app']);
    mocks.listTags.mockResolvedValue([
      tag('r1', 1),
      tag('r2', 2),
      tag('r3', 3),
      tag('r4', 4),
      tag('keep-recent', 5, 'sha256:dup'), // recent → kept → protects sha256:dup
      tag('old-dup', 200, 'sha256:dup'), // old + outside newest-5, but shares kept manifest → KEEP
      tag('junk', 210), // old, unique → DELETE
    ]);

    await cleanupImages();
    const deletedTags = mocks.deleteManifestByTag.mock.calls.map((c) => c[1]);
    expect(deletedTags).toContain('junk');
    expect(deletedTags).not.toContain('old-dup');
  });

  it('never throws on a single delete failure (best-effort)', async () => {
    mocks.deleteManifestByTag.mockRejectedValue(new Error('ACR 500'));
    mocks.listRepositories.mockResolvedValue(['proj-app']);
    mocks.listTags.mockResolvedValue([
      tag('n1', 40),
      tag('n2', 45),
      tag('n3', 50),
      tag('n4', 55),
      tag('n5', 60),
      tag('dead', 200),
    ]);

    await expect(cleanupImages()).resolves.toBeDefined();
  });
});

describe('cleanupImages no-op guards', () => {
  it('returns zeros when ACR creds are absent', async () => {
    vi.resetModules();
    vi.doMock('./acrRegistry.js', () => ({
      hasAcrCredentials: () => false,
      listRepositories: vi.fn(),
      listTags: vi.fn(),
      deleteManifestByTag: vi.fn(),
    }));
    vi.doMock('../azure/containerApps.js', () => ({
      isStub: () => false,
      getContainerAppImage: vi.fn(),
    }));
    vi.doMock('../../db.js', () => ({ prisma: { deployment: { findMany: vi.fn() } } }));
    const mod = await import('./cleanupImages.js');
    const res = await mod.cleanupImages();
    expect(res).toEqual({ scanned: 0, deleted: 0, kept: 0, perRepo: [] });
    vi.doUnmock('./acrRegistry.js');
    vi.doUnmock('../azure/containerApps.js');
    vi.doUnmock('../../db.js');
    vi.resetModules();
  });
});
