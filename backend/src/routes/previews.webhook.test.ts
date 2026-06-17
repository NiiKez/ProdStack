// Preview / PR environments: the `pull_request` webhook gating matrix. Mirrors
// webhooks.test.ts (HMAC + supertest), but mocks the previewService side-effects
// (upsert / teardownByPr) so this file exercises the ROUTE gating, not the DB.
// `isTrustedPullRequest` is kept REAL (the security gate is the point).
//
// ENABLE_PREVIEWS is read at env load → set it true before importing app.
process.env.NODE_ENV = 'test';
process.env.WEB_ORIGIN = 'http://localhost:5173';
process.env.PUBLIC_API_URL = 'http://localhost:3000';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.JWT_SECRET = 'test-jwt-secret-test-jwt-secret-test-jwt-secret';
process.env.COOKIE_SECRET = 'test-cookie-secret-0123456789-abcdefghij';
process.env.DATA_ENC_KEY = Buffer.alloc(32, 9).toString('base64');
process.env.GITHUB_OAUTH_CLIENT_ID = 'test-client-id';
process.env.GITHUB_OAUTH_CLIENT_SECRET = 'test-client-secret';
process.env.GITHUB_OAUTH_CALLBACK_URL = 'http://localhost:3000/api/auth/github/callback';
process.env.AZURE_STUB = 'true';
process.env.LOG_LEVEL = 'silent';
process.env.ENABLE_PREVIEWS = 'true';

import { createHmac } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { encrypt } from '../lib/crypto.js';

const WEBHOOK_SECRET = 'super-secret-webhook-key';

const mocks = vi.hoisted(() => ({
  projectFindFirst: vi.fn(),
  upsert: vi.fn(),
  teardownByPr: vi.fn(),
}));

const projectRow = (() => {
  const enc = encrypt(WEBHOOK_SECRET);
  return {
    id: 'p1',
    userId: 'u1',
    githubRepoFullName: 'octocat/hello',
    githubRepoId: 12345,
    branch: 'main',
    webhookSecretCiphertext: enc.ciphertext,
    webhookSecretIv: enc.iv,
    webhookSecretAuthTag: enc.authTag,
    webhookSecretKeyVersion: enc.keyVersion,
    containerAppName: 'octocat-hello',
    status: 'ACTIVE' as 'ACTIVE' | 'STOPPED',
    previewsEnabled: true,
    deletedAt: null as Date | null,
  };
})();

vi.mock('../db.js', () => ({
  prisma: { project: { findFirst: mocks.projectFindFirst } },
}));

// Keep the real trusted-author gate; stub only the side-effecting orchestration.
vi.mock('../services/previews/previewService.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    upsertPreviewAndEnqueueBuild: mocks.upsert,
    teardownPreviewByPr: mocks.teardownByPr,
  };
});

vi.mock('../middleware/requireAuth.js', () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
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

function prPayload(overrides: Record<string, unknown> = {}, prOverrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    action: 'opened',
    number: 42,
    repository: { id: 12345 },
    pull_request: {
      title: 'Add feature',
      head: { ref: 'feature-x', sha: 'a'.repeat(40), repo: { full_name: 'octocat/hello' } },
      base: { repo: { full_name: 'octocat/hello' } },
      user: { login: 'octocat' },
      author_association: 'OWNER',
      ...prOverrides,
    },
    ...overrides,
  });
}

async function send(body: string, delivery: string) {
  return supertest(createApp())
    .post('/api/webhooks/github')
    .set('Content-Type', 'application/json')
    .set('X-GitHub-Event', 'pull_request')
    .set('X-GitHub-Delivery', delivery)
    .set('X-Hub-Signature-256', sign(body))
    .send(body);
}

beforeEach(() => {
  mocks.projectFindFirst.mockReset().mockResolvedValue({ ...projectRow });
  mocks.upsert.mockReset().mockResolvedValue({ ok: true, previewId: 'pv1', buildId: 'b1', created: true });
  mocks.teardownByPr.mockReset().mockResolvedValue(true);
});
afterEach(() => vi.clearAllMocks());

describe('POST /api/webhooks/github — pull_request', () => {
  it('opened by a trusted author → 202 with previewId/buildId', async () => {
    const res = await send(prPayload(), 'd-open');
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ previewId: 'pv1', buildId: 'b1' });
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    const arg = mocks.upsert.mock.calls[0]![0];
    expect(arg).toMatchObject({ projectId: 'p1', deliveryId: 'd-open' });
    expect(arg.pr).toMatchObject({ prNumber: 42, headRef: 'feature-x', isFork: false });
  });

  it('synchronize → enqueues a rebuild', async () => {
    const res = await send(prPayload({ action: 'synchronize' }), 'd-sync');
    expect(res.status).toBe(202);
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
  });

  it('closed → tears down the preview (no build) and returns 202', async () => {
    const res = await send(prPayload({ action: 'closed' }), 'd-close');
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ok: true, prNumber: 42, tornDown: true });
    expect(mocks.teardownByPr).toHaveBeenCalledWith('p1', 42);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('closed tears down even when the project toggle is OFF (teardown precedes the gate)', async () => {
    mocks.projectFindFirst.mockResolvedValue({ ...projectRow, previewsEnabled: false });
    const res = await send(prPayload({ action: 'closed' }), 'd-close2');
    expect(res.status).toBe(202);
    expect(mocks.teardownByPr).toHaveBeenCalledWith('p1', 42);
  });

  it('rejects a FORK PR with 202 untrusted (no upsert)', async () => {
    const body = prPayload({}, { head: { ref: 'x', sha: 'a'.repeat(40), repo: { full_name: 'mallory/hello' } } });
    const res = await send(body, 'd-fork');
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ignored: 'untrusted author' });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('treats a same-repo PR with case-differing full_name as trusted (not a fork)', async () => {
    // GitHub repo full_names are case-insensitive — a payload whose head/base
    // casing differs must NOT be misclassified as a fork and rejected.
    const body = prPayload(
      {},
      {
        head: { ref: 'feature-x', sha: 'a'.repeat(40), repo: { full_name: 'Octocat/Hello' } },
        base: { repo: { full_name: 'octocat/hello' } },
      },
    );
    const res = await send(body, 'd-casefold');
    expect(res.status).toBe(202);
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    expect(mocks.upsert.mock.calls[0]![0].pr).toMatchObject({ isFork: false });
  });

  it('treats a null head.repo (deleted fork) as a fork → 202 untrusted (no upsert)', async () => {
    const body = prPayload({}, { head: { ref: 'feature-x', sha: 'a'.repeat(40), repo: null } });
    const res = await send(body, 'd-nullrepo');
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ignored: 'untrusted author' });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('rejects an over-length branch name with 202 (no upsert)', async () => {
    const body = prPayload(
      {},
      { head: { ref: 'x'.repeat(300), sha: 'a'.repeat(40), repo: { full_name: 'octocat/hello' } } },
    );
    const res = await send(body, 'd-longbranch');
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ignored: 'invalid branch name' });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('truncates an over-long PR title before persisting it', async () => {
    const res = await send(prPayload({}, { title: 'T'.repeat(400) }), 'd-longtitle');
    expect(res.status).toBe(202);
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    expect(mocks.upsert.mock.calls[0]![0].pr.title).toHaveLength(256);
  });

  it('400s an absurd PR number (above int32)', async () => {
    const res = await send(prPayload({ number: 3_000_000_000 }), 'd-bignum');
    expect(res.status).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('rejects an untrusted association (CONTRIBUTOR) with 202 untrusted', async () => {
    const res = await send(prPayload({}, { author_association: 'CONTRIBUTOR' }), 'd-contrib');
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ignored: 'untrusted author' });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('ignores when previews are disabled for the project (202)', async () => {
    mocks.projectFindFirst.mockResolvedValue({ ...projectRow, previewsEnabled: false });
    const res = await send(prPayload(), 'd-disabled');
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ignored: 'previews disabled for project' });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('ignores when the project is STOPPED (202)', async () => {
    mocks.projectFindFirst.mockResolvedValue({ ...projectRow, status: 'STOPPED' });
    const res = await send(prPayload(), 'd-stopped');
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ignored: 'project stopped' });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('rejects a git-option-injection head sha with 202 (no upsert)', async () => {
    const res = await send(prPayload({}, { head: { ref: 'x', sha: '--upload-pack=touch /tmp/x', repo: { full_name: 'octocat/hello' } } }), 'd-inject');
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ignored: 'invalid commit sha' });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('rejects a flag-injection branch name with 202 (no upsert)', async () => {
    const res = await send(prPayload({}, { head: { ref: '-x', sha: 'a'.repeat(40), repo: { full_name: 'octocat/hello' } } }), 'd-branch');
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ignored: 'invalid branch name' });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('maps a per-project cap to 202 preview limit reached', async () => {
    mocks.upsert.mockResolvedValue({ ok: false, reason: 'limit_reached' });
    const res = await send(prPayload(), 'd-cap');
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ignored: 'preview limit reached' });
  });

  it('maps a duplicate delivery to 200 { duplicate: true }', async () => {
    mocks.upsert.mockResolvedValue({ ok: false, reason: 'duplicate' });
    const res = await send(prPayload(), 'd-dup');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, duplicate: true });
  });

  it('returns 204 for a non-build action (labeled)', async () => {
    const res = await send(prPayload({ action: 'labeled' }), 'd-label');
    expect(res.status).toBe(204);
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.teardownByPr).not.toHaveBeenCalled();
  });

  it('rejects an invalid HMAC signature with 401 (no upsert)', async () => {
    const body = prPayload();
    const res = await supertest(createApp())
      .post('/api/webhooks/github')
      .set('Content-Type', 'application/json')
      .set('X-GitHub-Event', 'pull_request')
      .set('X-GitHub-Delivery', 'd-bad')
      .set('X-Hub-Signature-256', sign(body, 'wrong'))
      .send(body);
    expect(res.status).toBe(401);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('400s a malformed payload (missing pull_request)', async () => {
    const body = JSON.stringify({ action: 'opened', number: 42, repository: { id: 12345 } });
    const res = await send(body, 'd-malformed');
    expect(res.status).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  // env is read at import → re-import the app with the flag flipped (the hoisted
  // vi.mock factories re-apply to the freshly-imported modules).
  it('ignores all PR events with 202 when ENABLE_PREVIEWS is off', async () => {
    process.env.ENABLE_PREVIEWS = 'false';
    vi.resetModules();
    try {
      const { createApp: app2 } = await import('../app.js');
      const body = prPayload();
      const res = await supertest(app2())
        .post('/api/webhooks/github')
        .set('Content-Type', 'application/json')
        .set('X-GitHub-Event', 'pull_request')
        .set('X-GitHub-Delivery', 'd-feat-off')
        .set('X-Hub-Signature-256', sign(body))
        .send(body);
      expect(res.status).toBe(202);
      expect(res.body).toEqual({ ignored: 'previews disabled' });
      expect(mocks.upsert).not.toHaveBeenCalled();
    } finally {
      process.env.ENABLE_PREVIEWS = 'true';
      vi.resetModules();
    }
  });

  it('refuses a NEW preview with 503 under KILL_SWITCH, but still tears down on close', async () => {
    process.env.KILL_SWITCH = 'true';
    vi.resetModules();
    try {
      const { createApp: app2 } = await import('../app.js');
      const openBody = prPayload();
      const openRes = await supertest(app2())
        .post('/api/webhooks/github')
        .set('Content-Type', 'application/json')
        .set('X-GitHub-Event', 'pull_request')
        .set('X-GitHub-Delivery', 'd-killed-open')
        .set('X-Hub-Signature-256', sign(openBody))
        .send(openBody);
      expect(openRes.status).toBe(503);
      expect(openRes.body).toMatchObject({ error: 'BUILDS_PAUSED' });
      expect(mocks.upsert).not.toHaveBeenCalled();

      const closeBody = prPayload({ action: 'closed' });
      const closeRes = await supertest(app2())
        .post('/api/webhooks/github')
        .set('Content-Type', 'application/json')
        .set('X-GitHub-Event', 'pull_request')
        .set('X-GitHub-Delivery', 'd-killed-close')
        .set('X-Hub-Signature-256', sign(closeBody))
        .send(closeBody);
      expect(closeRes.status).toBe(202);
      expect(mocks.teardownByPr).toHaveBeenCalledWith('p1', 42);
    } finally {
      delete process.env.KILL_SWITCH;
      vi.resetModules();
    }
  });
});
