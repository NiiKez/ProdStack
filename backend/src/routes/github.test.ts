process.env.NODE_ENV = 'test';
process.env.DATA_ENC_KEY ??= Buffer.alloc(32, 9).toString('base64');
process.env.JWT_SECRET ??= 'x'.repeat(40);
process.env.COOKIE_SECRET ??= 'y'.repeat(40);
process.env.WEB_ORIGIN ??= 'http://localhost:5173';
process.env.GITHUB_OAUTH_CLIENT_ID ??= 'cid';
process.env.GITHUB_OAUTH_CLIENT_SECRET ??= 'csecret';
process.env.GITHUB_OAUTH_CALLBACK_URL ??= 'http://localhost:3000/api/auth/github/callback';
process.env.DATABASE_URL ??= 'postgresql://test/test';
process.env.AZURE_STUB ??= 'true';
process.env.LOG_LEVEL ??= 'silent';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { encrypt } from '../lib/crypto.js';

const tokenField = encrypt('ghp_dummy_token');

const state = vi.hoisted(() => ({
  stubAuth: true,
}));

const userRow = {
  id: 'u1',
  githubLogin: 'octocat',
  email: 'octo@example.com',
  avatarUrl: null,
  githubTokenCiphertext: tokenField.ciphertext,
  githubTokenIv: tokenField.iv,
  githubTokenAuthTag: tokenField.authTag,
  githubTokenKeyVersion: tokenField.keyVersion,
};

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  octokitForUser: vi.fn(),
  octokitPaginate: vi.fn(),
  octokitRequest: vi.fn(),
}));

vi.mock('../db.js', () => ({
  prisma: {
    user: { findUnique: mocks.userFindUnique },
  },
}));

// Keep the real `listUserRepos` + `GithubReposError` so the route's mapping of
// a GitHub failure → 502 GITHUB_UNAVAILABLE is exercised; only swap the Octokit
// factory so we can drive `octokit.paginate` from the test.
vi.mock('../services/github.js', async () => {
  const actual = (await vi.importActual('../services/github.js')) as Record<string, unknown>;
  return {
    ...actual,
    octokitForUser: mocks.octokitForUser,
  };
});

vi.mock('../middleware/requireAuth.js', () => ({
  requireAuth: (
    req: { user?: unknown },
    res: { status: (n: number) => { json: (b: unknown) => void } },
    next: () => void,
  ) => {
    if (state.stubAuth) {
      req.user = {
        id: 'u1',
        githubLogin: 'octocat',
        email: 'octo@example.com',
        avatarUrl: null,
      };
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

// GitHub `/user/repos` rows (only the fields the route maps). Listed
// out-of-order on purpose so a test can assert the route preserves GitHub's
// `sort=pushed&direction=desc` ordering as-is.
const ghRepoRows = [
  {
    full_name: 'octocat/recent',
    html_url: 'https://github.com/octocat/recent',
    default_branch: 'main',
    private: false,
  },
  {
    full_name: 'acme/private-svc',
    html_url: 'https://github.com/acme/private-svc',
    default_branch: 'develop',
    private: true,
  },
];

beforeEach(() => {
  state.stubAuth = true;

  mocks.userFindUnique.mockReset();
  mocks.octokitForUser.mockReset();
  mocks.octokitPaginate.mockReset();
  mocks.octokitRequest.mockReset();

  mocks.userFindUnique.mockResolvedValue(userRow);
  mocks.octokitPaginate.mockResolvedValue(ghRepoRows);
  mocks.octokitForUser.mockReturnValue({
    paginate: mocks.octokitPaginate,
    request: mocks.octokitRequest,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/github/repos', () => {
  it('rejects unauthenticated requests with 401', async () => {
    state.stubAuth = false;
    const app = createApp();
    const res = await supertest(app).get('/api/github/repos');
    expect(res.status).toBe(401);
  });

  it('returns mapped repos for an authed user (200)', async () => {
    const app = createApp();
    const res = await supertest(app).get('/api/github/repos');

    expect(res.status).toBe(200);
    expect(res.body.repos).toEqual([
      {
        fullName: 'octocat/recent',
        url: 'https://github.com/octocat/recent',
        defaultBranch: 'main',
        private: false,
      },
      {
        fullName: 'acme/private-svc',
        url: 'https://github.com/acme/private-svc',
        defaultBranch: 'develop',
        private: true,
      },
    ]);

    // Affiliation + sort params are passed through to GitHub.
    expect(mocks.octokitPaginate).toHaveBeenCalledWith('GET /user/repos', {
      affiliation: 'owner,collaborator,organization_member',
      sort: 'pushed',
      direction: 'desc',
      per_page: 100,
    });
  });

  it('preserves GitHub’s pushed-desc ordering as returned', async () => {
    const app = createApp();
    const res = await supertest(app).get('/api/github/repos');
    expect(res.status).toBe(200);
    expect(res.body.repos.map((r: { fullName: string }) => r.fullName)).toEqual([
      'octocat/recent',
      'acme/private-svc',
    ]);
  });

  it('502 GITHUB_UNAVAILABLE when the user has no stored token', async () => {
    // A user row whose token columns are absent → decrypt() throws → mapped to 502.
    mocks.userFindUnique.mockResolvedValue({
      id: 'u1',
      githubLogin: 'octocat',
      email: null,
      avatarUrl: null,
      githubTokenCiphertext: '',
      githubTokenIv: '',
      githubTokenAuthTag: '',
      githubTokenKeyVersion: 1,
    });

    const app = createApp();
    const res = await supertest(app).get('/api/github/repos');
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('GITHUB_UNAVAILABLE');
    expect(mocks.octokitPaginate).not.toHaveBeenCalled();
  });

  it('502 GITHUB_UNAVAILABLE when GitHub returns 401', async () => {
    mocks.octokitPaginate.mockImplementation(async () => {
      const err: Error & { status?: number; response?: { data: { message: string } } } = new Error(
        'Bad credentials',
      );
      err.status = 401;
      err.response = { data: { message: 'Bad credentials' } };
      throw err;
    });

    const app = createApp();
    const res = await supertest(app).get('/api/github/repos');
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('GITHUB_UNAVAILABLE');
  });
});

describe('POST /api/github/detect', () => {
  /** Drive `octokit.request` for the trees call + per-file Contents calls. */
  function wireRepo(tree: Array<{ path: string }>, files: Record<string, string> = {}) {
    mocks.octokitRequest.mockImplementation(async (route: string, params: { path?: string }) => {
      if (route.includes('git/trees')) {
        return { data: { tree: tree.map((t) => ({ ...t, type: 'blob' })) } };
      }
      if (route.includes('/contents/')) {
        const content = params.path ? files[params.path] : undefined;
        if (content === undefined) {
          const err: Error & { status?: number } = new Error('Not Found');
          err.status = 404;
          throw err;
        }
        return { data: { content: Buffer.from(content).toString('base64'), encoding: 'base64' } };
      }
      throw new Error(`unexpected octokit route ${route}`);
    });
  }

  const detect = (app: ReturnType<typeof createApp>, repoUrl: string) =>
    supertest(app)
      .post('/api/github/detect')
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({ repoUrl });

  it('reports hasDockerfile when the repo ships its own Dockerfile', async () => {
    wireRepo([{ path: 'Dockerfile' }, { path: 'server.js' }]);
    const app = createApp();
    const res = await detect(app, 'https://github.com/octocat/hello');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hasDockerfile: true, framework: null, port: null });
  });

  it('detects a Node/Express app (no Dockerfile) and returns its port', async () => {
    wireRepo([{ path: 'package.json' }, { path: 'index.js' }], {
      'package.json': JSON.stringify({
        dependencies: { express: '^4.19.0' },
        scripts: { start: 'node index.js' },
      }),
    });
    const app = createApp();
    const res = await detect(app, 'https://github.com/octocat/hello');
    expect(res.status).toBe(200);
    expect(res.body.hasDockerfile).toBe(false);
    expect(typeof res.body.framework).toBe('string');
    expect(res.body.port).toBe(3000);
  });

  it('returns hasDockerfile:false, framework:null for an unrecognized repo', async () => {
    wireRepo([{ path: 'README.md' }, { path: 'LICENSE' }]);
    const app = createApp();
    const res = await detect(app, 'https://github.com/octocat/hello');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hasDockerfile: false, framework: null, port: null });
  });

  it('400 on a non-GitHub repo URL', async () => {
    const app = createApp();
    const res = await detect(app, 'https://gitlab.com/x/y');
    expect(res.status).toBe(400);
    expect(mocks.octokitRequest).not.toHaveBeenCalled();
  });

  it('502 GITHUB_UNAVAILABLE when the repo tree cannot be read', async () => {
    mocks.octokitRequest.mockImplementation(async () => {
      const err: Error & { status?: number } = new Error('Not Found');
      err.status = 404;
      throw err;
    });
    const app = createApp();
    const res = await detect(app, 'https://github.com/octocat/private');
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('GITHUB_UNAVAILABLE');
  });
});
