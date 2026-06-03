import type { Page, Route, Request } from '@playwright/test';
import type { CurrentUser } from '../src/hooks/useCurrentUser';
import type { GithubRepo, ProjectSummary } from '../src/types/api';

/**
 * Hermetic backend stub for the E2E suite.
 *
 * Every spec routes ALL `/api/**` calls through `mockBackend` (or a more
 * specific `page.route` registered *before* it). No real API, Postgres, or
 * GitHub OAuth is ever contacted — the Vite dev server proxies `/api` to
 * localhost:3000, but Playwright fulfils the request in-browser first.
 *
 * Selectors in the specs target roles / accessible names / visible text only,
 * so a restyle that keeps the same user flows keeps these tests green. The
 * fixture data below is the single source of truth for the names/labels the
 * specs assert on.
 */

export const ownerUser: CurrentUser = {
  id: 'user_owner_1',
  githubLogin: 'octocat',
  email: 'octocat@example.com',
  avatarUrl: null,
};

/** Two fully-populated projects for the dashboard list test. */
export const sampleProjects: ProjectSummary[] = [
  {
    id: 'proj_alpha',
    name: 'Alpha Service',
    slug: 'alpha-service',
    githubRepoFullName: 'octocat/alpha-service',
    branch: 'main',
    liveUrl: 'https://alpha-service.example.com',
    containerAppName: 'app-alpha-service',
    createdAt: '2026-05-01T10:00:00.000Z',
    updatedAt: '2026-05-20T10:00:00.000Z',
    latestBuild: {
      id: 'build_alpha_1',
      status: 'ready',
      commitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      commitMessage: 'Initial deploy',
      createdAt: '2026-05-20T10:00:00.000Z',
    },
    activeDeployment: {
      id: 'dep_alpha_1',
      revisionName: 'app-alpha-service--0000001',
      createdAt: '2026-05-20T10:05:00.000Z',
    },
  },
  {
    id: 'proj_beta',
    name: 'Beta Worker',
    slug: 'beta-worker',
    githubRepoFullName: 'octocat/beta-worker',
    branch: 'develop',
    liveUrl: null,
    containerAppName: 'app-beta-worker',
    createdAt: '2026-05-10T10:00:00.000Z',
    updatedAt: '2026-05-18T10:00:00.000Z',
    latestBuild: {
      id: 'build_beta_1',
      status: 'failed',
      commitSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      commitMessage: 'Fix worker entrypoint',
      createdAt: '2026-05-18T10:00:00.000Z',
    },
    activeDeployment: null,
  },
];

/**
 * Fake GitHub repo list for the New Project picker. Backend returns these
 * most-recently-pushed first as `{ repos: [...] }`; the picker filters/selects
 * them. `octocat/my-new-app` matches the project the create-project spec creates.
 */
export const sampleRepos: GithubRepo[] = [
  {
    fullName: 'octocat/my-new-app',
    url: 'https://github.com/octocat/my-new-app',
    defaultBranch: 'main',
    private: false,
  },
  {
    fullName: 'octocat/secret-tool',
    url: 'https://github.com/octocat/secret-tool',
    defaultBranch: 'develop',
    private: true,
  },
  {
    fullName: 'octocat/legacy-site',
    url: 'https://github.com/octocat/legacy-site',
    defaultBranch: 'master',
    private: false,
  },
];

/** Build a fresh ProjectSummary (used as the POST /api/projects success body). */
export function makeProject(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id: 'proj_new',
    name: 'My New App',
    slug: 'my-new-app',
    githubRepoFullName: 'octocat/my-new-app',
    branch: 'main',
    liveUrl: null,
    containerAppName: 'app-my-new-app',
    createdAt: '2026-06-02T12:00:00.000Z',
    updatedAt: '2026-06-02T12:00:00.000Z',
    latestBuild: null,
    activeDeployment: null,
    ...overrides,
  };
}

export interface MockBackendOptions {
  /**
   * `null` → the current-user endpoint replies 401 (unauthenticated). An
   * object → replies 200 with that user. Defaults to `ownerUser`.
   */
  user?: CurrentUser | null;
  /** Projects list returned by `GET /api/projects`. Defaults to `[]`. */
  projects?: ProjectSummary[];
  /**
   * Repos returned by `GET /api/github/repos` (wrapped as `{ repos }`).
   * Defaults to `sampleRepos`. Pass `'error'` to make the endpoint reply 502
   * (so the modal falls back to manual URL entry), or `[]` for an empty list
   * (which also triggers the manual fallback).
   */
  repos?: GithubRepo[] | 'error';
}

function json(route: Route, status: number, body: unknown): Promise<void> {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

/**
 * Catch-all `/api/**` interceptor. Register this LAST — any `page.route` added
 * after a previous one runs first, so per-test overrides (e.g. a POST handler)
 * should be registered AFTER calling `mockBackend`, or `mockBackend` should be
 * called first and the override second.
 *
 * Endpoints handled:
 *   GET  /api/auth/me      → 200 user | 401
 *   GET  /api/health       → 200 { status:'ok', killSwitch:false }
 *   GET  /api/projects     → 200 { projects: [...] }
 *   GET  /api/projects/:id → 200 project detail (so post-create navigation is hermetic)
 *   GET  /api/github/repos → 200 { repos: [...] } | 502 (when `repos === 'error'`)
 *   *    everything else    → 404 JSON (never reaches the real backend)
 */
export async function mockBackend(page: Page, options: MockBackendOptions = {}): Promise<void> {
  const user = options.user === undefined ? ownerUser : options.user;
  const projects = options.projects ?? [];
  const repos = options.repos === undefined ? sampleRepos : options.repos;

  await page.route('**/api/**', async (route: Route, request: Request) => {
    const method = request.method();
    const path = new URL(request.url()).pathname;

    if (path === '/api/auth/me' && method === 'GET') {
      if (!user) {
        return json(route, 401, { error: 'UNAUTHORIZED', message: 'Not signed in' });
      }
      return json(route, 200, user);
    }

    if (path === '/api/health' && method === 'GET') {
      return json(route, 200, { status: 'ok', killSwitch: false });
    }

    if (path === '/api/projects' && method === 'GET') {
      return json(route, 200, { projects });
    }

    if (path === '/api/github/repos' && method === 'GET') {
      if (repos === 'error') {
        return json(route, 502, { error: 'GITHUB_UNAVAILABLE' });
      }
      return json(route, 200, { repos });
    }

    // Project detail — lets the create flow's post-success navigation resolve
    // without hitting a real backend. Returns a minimal valid detail body.
    if (/^\/api\/projects\/[^/]+$/.test(path) && method === 'GET') {
      const id = path.split('/').pop()!;
      const known = projects.find((p) => p.id === id);
      const base = known ?? makeProject({ id });
      return json(route, 200, { ...base, builds: [], envVars: [] });
    }

    // Anything not explicitly mocked: fail loud with JSON, never reach :3000.
    return json(route, 404, {
      error: 'NOT_MOCKED',
      message: `Unmocked ${method} ${path}`,
    });
  });
}
