import type { Page, Route, Request } from '@playwright/test';
import type { CurrentUser } from '../src/hooks/useCurrentUser';
import type {
  BuildDetail,
  BuildListItem,
  DeploymentListItem,
  DetectFrameworkResult,
  GithubRepo,
  LogLine,
  PreviewSummary,
  ProjectDetail,
  ProjectSummary,
} from '../src/types/api';

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
  isDemo: false,
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
    autoDeploy: true,
    previewsEnabled: true,
    status: 'ACTIVE',
    stoppedAt: null,
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
    autoDeploy: true,
    previewsEnabled: false,
    status: 'ACTIVE',
    stoppedAt: null,
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
    autoDeploy: true,
    previewsEnabled: true,
    status: 'ACTIVE',
    stoppedAt: null,
    createdAt: '2026-06-02T12:00:00.000Z',
    updatedAt: '2026-06-02T12:00:00.000Z',
    latestBuild: null,
    activeDeployment: null,
    ...overrides,
  };
}

/**
 * Build a full `ProjectDetail` (the `GET /api/projects/:id` body) for the
 * deploy-lifecycle specs. Adds the detail-only `builds` + `envVars` fields on
 * top of the summary factory; pass `envVars` as the masked `{key,hasValue}`
 * server shape.
 */
export function makeProjectDetail(
  overrides: Partial<ProjectDetail> = {},
): ProjectDetail {
  const { builds, envVars, ...summaryOverrides } = overrides;
  return {
    ...makeProject(summaryOverrides),
    builds: builds ?? [],
    envVars: envVars ?? [],
  };
}

/**
 * Visible-copy the deploy-lifecycle specs assert on, centralized here so a
 * restyle that keeps the same flows only has to touch this module (the
 * "test logic not markup" rule from docs/TESTING.md). Each string is the
 * literal toast title / button name / status label the component renders.
 */
export const copy = {
  // Build logs page (BuildLogs.tsx + StageStepper).
  buildLogsHeading: 'Build logs',
  stageReady: 'Ready',
  // Rollback (ProjectDetail DeploymentsTab + ConfirmDialog).
  // The table action button is one word ("Rollback"); the dialog's confirm
  // button is two words ("Roll back") — they're deliberately distinct.
  rollbackButton: 'Rollback',
  rollbackConfirmButton: 'Roll back',
  rollbackConfirmTitle: 'Roll back to this deployment?',
  // Env-var save (SettingsTab — RedeployReason toasts).
  envSavedRedeploying: 'Environment variables saved — redeploying with your latest image.',
  envSavedNoActive: "Saved. They'll apply on your first deploy.",
  envSaveButton: 'Save variables',
  // Stop / resume (ProjectHeaderCard).
  statusActive: 'Active',
  statusStopped: 'Stopped',
  stopButton: 'Stop',
  resumeButton: 'Resume',
  stoppedToast: 'Project stopped',
  resumedToast: 'Project resumed',
  // Previews (PreviewsTab).
  previewTeardownButton: 'Tear down',
  previewTeardownConfirmTitle: 'Tear down this preview?',
  previewsDisabledNote:
    'Preview environments are disabled for this project — enable them in Settings.',
  previewsEmptyTitle: 'No preview environments yet',
} as const;

/**
 * Build a `BuildListItem` (a row in `GET /api/projects/:id/builds`). Defaults to
 * a finished READY build; override `status` for in-flight rows.
 */
export function makeBuildListItem(overrides: Partial<BuildListItem> = {}): BuildListItem {
  return {
    id: 'build_1',
    status: 'ready',
    commitSha: 'cccccccccccccccccccccccccccccccccccccccc',
    commitMessage: 'Add a feature',
    commitAuthor: 'octocat',
    branch: 'main',
    imageTag: 'prodstack.azurecr.io/app:ccccccc',
    errorMessage: null,
    startedAt: '2026-06-10T10:00:00.000Z',
    finishedAt: '2026-06-10T10:02:00.000Z',
    durationMs: 120_000,
    createdAt: '2026-06-10T10:00:00.000Z',
    ...overrides,
  };
}

/**
 * Build a `BuildDetail` (`GET /api/builds/:id`) for the Build Logs page. The
 * embedded `project.liveUrl` is what surfaces under the stepper once READY.
 */
export function makeBuildDetail(overrides: Partial<BuildDetail> = {}): BuildDetail {
  return {
    id: 'build_1',
    status: 'READY',
    commitSha: 'cccccccccccccccccccccccccccccccccccccccc',
    commitMessage: 'Add a feature',
    commitAuthor: 'octocat',
    branch: 'main',
    imageTag: 'prodstack.azurecr.io/app:ccccccc',
    startedAt: '2026-06-10T10:00:00.000Z',
    finishedAt: '2026-06-10T10:02:00.000Z',
    durationMs: 120_000,
    errorMessage: null,
    createdAt: '2026-06-10T10:00:00.000Z',
    project: {
      id: 'proj_1',
      name: 'My App',
      githubRepoFullName: 'octocat/my-app',
      liveUrl: 'https://my-app.example.com',
    },
    ...overrides,
  };
}

/** Build a `DeploymentListItem` (`GET /api/projects/:id/deployments`). */
export function makeDeployment(overrides: Partial<DeploymentListItem> = {}): DeploymentListItem {
  return {
    id: 'dep_1',
    revisionName: 'app--0000001',
    active: false,
    rolledBack: false,
    createdAt: '2026-06-10T10:05:00.000Z',
    build: {
      id: 'build_1',
      status: 'READY',
      commitSha: 'cccccccccccccccccccccccccccccccccccccccc',
      commitMessage: 'Add a feature',
      commitAuthor: 'octocat',
      branch: 'main',
      imageTag: 'prodstack.azurecr.io/app:ccccccc',
    },
    ...overrides,
  };
}

/** Build a `PreviewSummary` (`GET /api/projects/:id/previews`). */
export function makePreview(overrides: Partial<PreviewSummary> = {}): PreviewSummary {
  return {
    id: 'preview_1',
    prNumber: 42,
    title: 'Add a shiny feature',
    headRef: 'feature/shiny',
    headSha: 'dddddddddddddddddddddddddddddddddddddddd',
    authorLogin: 'octocat',
    status: 'ACTIVE',
    liveUrl: 'https://pr-42.preview.example.com',
    lastBuildId: 'build_preview_1',
    // Far-future TTL so the row reads "expires …" not "expired …".
    expiresAt: '2099-01-01T00:00:00.000Z',
    closedAt: null,
    createdAt: '2026-06-10T10:00:00.000Z',
    updatedAt: '2026-06-10T10:00:00.000Z',
    ...overrides,
  };
}

/**
 * Serialize a pre-scripted SSE event sequence as a single `text/event-stream`
 * body. Playwright's `route.fulfill` can't stream, so we hand `EventSource` the
 * whole transcript at once: it parses the events in order and the `useBuildLogs`
 * hook closes the stream on the terminal `done` event (no reconnect storm).
 *
 * Each entry becomes `event: <name>\ndata: <json>\n\n`; `log` events also carry
 * an `id: <seq>` line (the real server stamps these for Last-Event-ID resume).
 */
export function sseBody(
  events: ReadonlyArray<{ event: 'log' | 'status' | 'done'; data: unknown }>,
): string {
  return (
    events
      .map(({ event, data }) => {
        const idLine =
          event === 'log' && data && typeof data === 'object' && 'seq' in data
            ? `id: ${(data as LogLine).seq}\n`
            : '';
        return `${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      })
      .join('')
  );
}

/**
 * A happy-path build transcript: a few log lines, status events climbing
 * through the build stages, and a terminal `done: READY`. Drives the Build Logs
 * UI from "Connecting…" to the Ready stage.
 */
export const readyBuildStream: ReadonlyArray<{
  event: 'log' | 'status' | 'done';
  data: unknown;
}> = [
  { event: 'status', data: { status: 'CLONING' } },
  { event: 'log', data: { seq: 1, level: 'STEP', message: 'Cloning octocat/my-app', ts: '2026-06-10T10:00:01.000Z' } },
  { event: 'status', data: { status: 'BUILDING' } },
  { event: 'log', data: { seq: 2, level: 'INFO', message: 'Building image with Kaniko', ts: '2026-06-10T10:00:30.000Z' } },
  { event: 'status', data: { status: 'PUSHING' } },
  { event: 'log', data: { seq: 3, level: 'INFO', message: 'Pushing image to ACR', ts: '2026-06-10T10:01:30.000Z' } },
  { event: 'status', data: { status: 'DEPLOYING' } },
  { event: 'log', data: { seq: 4, level: 'SUCCESS', message: 'Deployed revision app--0000002', ts: '2026-06-10T10:02:00.000Z' } },
  { event: 'done', data: { status: 'READY' } },
];

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
  /**
   * Response for `POST /api/github/detect` (the New Project framework preview).
   * Defaults to a detected Express app. Pass `'error'` to reply 502 (the
   * preview then stays hidden, as it does for the tokenless dev-login user).
   */
  detect?: DetectFrameworkResult | 'error';

  // --- Deploy-lifecycle surfaces (project detail page) --------------------
  // These let a spec stub a single project's detail page + its tabs. Provide
  // `detail` for the project under test; the per-tab arrays default to empty so
  // an unconfigured tab renders its empty state rather than 404-ing.

  /**
   * Full `GET /api/projects/:id` detail body for the project under test. When
   * set, it's returned verbatim for that id (and `builds`/`envVars` come from
   * here). When unset, the catch-all synthesizes a minimal detail (as before).
   */
  detail?: ProjectDetail;
  /** `GET /api/projects/:id/builds` items (wrapped as a `Paginated` page). */
  builds?: BuildListItem[];
  /** `GET /api/projects/:id/deployments` items (wrapped as a `Paginated` page). */
  deployments?: DeploymentListItem[];
  /** `GET /api/projects/:id/previews` items (wrapped as `{ previews }`). */
  previews?: PreviewSummary[];
  /** Per-build-id `GET /api/builds/:buildId` detail bodies for the logs page. */
  buildDetails?: Record<string, BuildDetail>;
  /**
   * Per-build-id SSE transcript for `GET /api/builds/:buildId/logs/stream`,
   * built with `sseBody(...)`. When a build id isn't listed the stream replies
   * with an empty body (the page falls back to the fetched build status).
   */
  buildStreams?: Record<string, string>;
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
  const detect: DetectFrameworkResult | 'error' =
    options.detect === undefined ? { hasDockerfile: false, framework: 'Express', port: 3000 } : options.detect;
  const detail = options.detail;
  const builds = options.builds ?? [];
  const deployments = options.deployments ?? [];
  const previews = options.previews ?? [];
  const buildDetails = options.buildDetails ?? {};
  const buildStreams = options.buildStreams ?? {};

  await page.route('**/api/**', async (route: Route, request: Request) => {
    const method = request.method();
    const path = new URL(request.url()).pathname;

    // --- Deploy-lifecycle GET endpoints (matched before the generic /:id) ---

    // Build-log SSE stream. A single `text/event-stream` body containing the
    // whole pre-scripted transcript; EventSource parses it in order.
    const streamMatch = path.match(/^\/api\/builds\/([^/]+)\/logs\/stream$/);
    if (streamMatch && method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        headers: { 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
        body: buildStreams[streamMatch[1]!] ?? '',
      });
    }

    // Build detail (`GET /api/builds/:buildId`).
    const buildMatch = path.match(/^\/api\/builds\/([^/]+)$/);
    if (buildMatch && method === 'GET') {
      const b = buildDetails[buildMatch[1]!];
      if (b) return json(route, 200, b);
      return json(route, 404, { error: 'NOT_FOUND', message: 'No such build' });
    }

    // Per-project list tabs (builds / deployments / previews).
    const buildsMatch = path.match(/^\/api\/projects\/[^/]+\/builds$/);
    if (buildsMatch && method === 'GET') {
      return json(route, 200, { items: builds, nextCursor: null });
    }
    const depsMatch = path.match(/^\/api\/projects\/[^/]+\/deployments$/);
    if (depsMatch && method === 'GET') {
      return json(route, 200, { items: deployments, nextCursor: null });
    }
    const previewsMatch = path.match(/^\/api\/projects\/[^/]+\/previews$/);
    if (previewsMatch && method === 'GET') {
      return json(route, 200, { previews });
    }
    // Runtime logs + metrics tabs degrade gracefully if a spec lands on them.
    const runtimeMatch = path.match(/^\/api\/projects\/[^/]+\/runtime\/logs$/);
    if (runtimeMatch && method === 'GET') {
      return json(route, 200, { lines: [], available: true });
    }
    const metricsMatch = path.match(/^\/api\/projects\/[^/]+\/metrics$/);
    if (metricsMatch && method === 'GET') {
      return json(route, 200, { available: true, series: [] });
    }

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

    if (path === '/api/github/detect' && method === 'POST') {
      if (detect === 'error') {
        return json(route, 502, { error: 'GITHUB_UNAVAILABLE' });
      }
      return json(route, 200, detect);
    }

    // Project detail — lets the create flow's post-success navigation resolve
    // without hitting a real backend. A spec can pass a full `detail` body for
    // the deploy-lifecycle flows; otherwise we synthesize a minimal one.
    if (/^\/api\/projects\/[^/]+$/.test(path) && method === 'GET') {
      const id = path.split('/').pop()!;
      if (detail && detail.id === id) return json(route, 200, detail);
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
