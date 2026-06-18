import { expect, test, type Page, type Request } from '@playwright/test';
import {
  copy,
  makeBuildDetail,
  makeDeployment,
  makePreview,
  makeProjectDetail,
  mockBackend,
  ownerUser,
  readyBuildStream,
  sseBody,
} from './fixtures';

/**
 * Deploy-lifecycle E2E coverage — the gap the suite used to "stop at project
 * created" and never exercise: build streaming → Ready, rollback, env-var save,
 * stop/resume, and preview environments. All hermetic via `mockBackend` +
 * per-test `page.route` overrides (registered AFTER mockBackend so they win,
 * deferring unmatched requests with `route.fallback()`). Outcomes only —
 * toast/badge/status copy lives in `fixtures.ts` `copy`, never markup.
 */

const PROJECT_ID = 'proj_1';
const PROJECT_NAME = 'My App';

/**
 * Navigate to a project-detail route and wait for the page to settle before the
 * caller asserts on tab content. ProjectDetail is a heavy lazy chunk that shows
 * a full-page spinner until its `useProject` query resolves; under parallel load
 * (several workers sharing one dev server) that first paint can exceed the
 * default 5s assertion timeout, so the anchor (the project-name heading, shared
 * by every tab) gets a generous one. Everything after it is instant.
 */
async function gotoProject(page: Page, path: string) {
  await page.goto(path);
  await expect(page.getByRole('heading', { name: PROJECT_NAME, level: 1 })).toBeVisible({
    timeout: 20_000,
  });
}

/** Capture the parsed JSON body of the first matching mutation. */
function capturePost(
  page: Page,
  pattern: RegExp,
  status: number,
  body: unknown,
): { request: () => Request | null } {
  let captured: Request | null = null;
  void page.route('**/api/**', async (route) => {
    const req = route.request();
    if (req.method() === 'POST' && pattern.test(new URL(req.url()).pathname)) {
      captured = req;
      return route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    }
    return route.fallback();
  });
  return { request: () => captured };
}

// ---------------------------------------------------------------------------
// 1. Build streaming → Ready
// ---------------------------------------------------------------------------

test.describe('build streaming (authenticated)', () => {
  test('streams log lines, advances to Ready, and surfaces the live URL', async ({ page }) => {
    const buildId = 'build_stream_1';
    const detail = makeBuildDetail({
      id: buildId,
      status: 'READY',
      commitMessage: 'Ship it',
      project: {
        id: PROJECT_ID,
        name: 'My App',
        githubRepoFullName: 'octocat/my-app',
        liveUrl: 'https://my-app.example.com',
      },
    });

    await mockBackend(page, {
      user: ownerUser,
      buildDetails: { [buildId]: detail },
      buildStreams: { [buildId]: sseBody(readyBuildStream) },
    });

    await page.goto(`/projects/${PROJECT_ID}/builds/${buildId}`);

    // The log viewport renders the streamed lines (proves the SSE body drove the
    // hook). These are the messages from `readyBuildStream`.
    await expect(page.getByText('Cloning octocat/my-app')).toBeVisible();
    await expect(page.getByText('Building image with Kaniko')).toBeVisible();
    await expect(page.getByText('Deployed revision app--0000002')).toBeVisible();

    // The header status pill reads Ready (driven by the terminal done:READY).
    await expect(page.getByText(copy.stageReady).first()).toBeVisible();

    // On READY the deployment's live URL surfaces under the stepper.
    await expect(page.getByRole('link', { name: /my-app\.example\.com/ })).toBeVisible();

    // No Cancel button on a finished build (it's terminal, not in-flight).
    await expect(page.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
  });

  test('shows the failure error message when the build fails', async ({ page }) => {
    const buildId = 'build_stream_fail';
    const detail = makeBuildDetail({
      id: buildId,
      status: 'FAILED',
      errorMessage: 'kaniko exited with code 1',
      project: {
        id: PROJECT_ID,
        name: 'My App',
        githubRepoFullName: 'octocat/my-app',
        liveUrl: null,
      },
    });

    await mockBackend(page, {
      user: ownerUser,
      buildDetails: { [buildId]: detail },
      buildStreams: {
        [buildId]: sseBody([
          { event: 'status', data: { status: 'BUILDING' } },
          { event: 'log', data: { seq: 1, level: 'ERROR', message: 'compile error in app.js', ts: '2026-06-10T10:00:30.000Z' } },
          { event: 'done', data: { status: 'FAILED' } },
        ]),
      },
    });

    await page.goto(`/projects/${PROJECT_ID}/builds/${buildId}`);

    await expect(page.getByText('compile error in app.js')).toBeVisible();
    // The build-detail error message surfaces in the failed banner.
    await expect(page.getByText('kaniko exited with code 1')).toBeVisible();
    // A failed build never shows a live URL.
    await expect(page.getByRole('link', { name: /example\.com/ })).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Rollback
// ---------------------------------------------------------------------------

test.describe('rollback (authenticated)', () => {
  test('rolls back a prior deployment and shows the success toast', async ({ page }) => {
    const activeDep = makeDeployment({
      id: 'dep_active',
      revisionName: 'app--0000002',
      active: true,
      build: {
        id: 'build_active',
        status: 'READY',
        commitSha: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        commitMessage: 'Latest commit',
        commitAuthor: 'octocat',
        branch: 'main',
        imageTag: 'prodstack.azurecr.io/app:eeeeeee',
      },
    });
    const priorDep = makeDeployment({
      id: 'dep_prior',
      revisionName: 'app--0000001',
      active: false,
      build: {
        id: 'build_prior',
        status: 'READY',
        commitSha: 'abc1234000000000000000000000000000000000',
        commitMessage: 'Previous commit',
        commitAuthor: 'octocat',
        branch: 'main',
        imageTag: 'prodstack.azurecr.io/app:abc1234',
      },
    });

    await mockBackend(page, {
      user: ownerUser,
      detail: makeProjectDetail({ id: PROJECT_ID, name: 'My App' }),
      deployments: [activeDep, priorDep],
    });

    // Override the rollback POST (registered after mockBackend → wins).
    const rollback = capturePost(
      page,
      /^\/api\/projects\/[^/]+\/deployments\/[^/]+\/rollback$/,
      200,
      { ...priorDep, active: true },
    );

    await gotoProject(page, `/projects/${PROJECT_ID}?tab=deployments`);

    // Both deployment revisions render; only the inactive one offers Rollback.
    await expect(page.getByText('app--0000002')).toBeVisible();
    await expect(page.getByText('app--0000001')).toBeVisible();

    // Trigger rollback on the prior (inactive) deployment. There's exactly one
    // Rollback button (the active row has none).
    await page.getByRole('button', { name: copy.rollbackButton }).click();

    // Confirmation dialog references the target commit SHA.
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(copy.rollbackConfirmTitle)).toBeVisible();
    await expect(dialog.getByText(/abc1234/)).toBeVisible();

    await dialog.getByRole('button', { name: copy.rollbackConfirmButton }).click();

    // Success toast shows the 7-char SHA of the rolled-back deployment.
    await expect(page.getByText('Rolling back to abc1234…')).toBeVisible();

    // The POST fired against the PRIOR deployment's id (not the active one).
    const req = rollback.request();
    expect(req).not.toBeNull();
    expect(new URL(req!.url()).pathname).toContain('/deployments/dep_prior/rollback');
  });
});

// ---------------------------------------------------------------------------
// 3. Env-var save (write-only partial-update contract)
// ---------------------------------------------------------------------------

test.describe('env-var save (authenticated)', () => {
  test('saves an edited stored var + a new var, honoring the write-only contract', async ({
    page,
  }) => {
    // The project has one stored secret (DATABASE_URL) — masked, no value sent
    // by the server. The user will EDIT it and ADD a new PORT var, then keep a
    // second untouched stored var (API_KEY) whose value must be OMITTED.
    const detail = makeProjectDetail({
      id: PROJECT_ID,
      name: 'My App',
      envVars: [
        { key: 'DATABASE_URL', hasValue: true },
        { key: 'API_KEY', hasValue: true },
      ],
    });

    await mockBackend(page, { user: ownerUser, detail });

    // Capture the PATCH; reply with a masked detail + a redeploy summary.
    let patchBody: Record<string, unknown> | null = null;
    await page.route('**/api/**', async (route) => {
      const req = route.request();
      if (req.method() === 'PATCH') {
        patchBody = req.postDataJSON() as Record<string, unknown>;
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ...detail,
            envVars: [
              { key: 'DATABASE_URL', hasValue: true },
              { key: 'API_KEY', hasValue: true },
              { key: 'PORT', hasValue: true },
            ],
            redeploy: { redeployed: true },
          }),
        });
      }
      return route.fallback();
    });

    await gotoProject(page, `/projects/${PROJECT_ID}?tab=settings`);

    // Stored secrets render as masked rows (key visible, value field empty with
    // a "(set — type to replace)" placeholder). Edit DATABASE_URL (row 1) to a
    // new value.
    await expect(page.getByLabel('Variable 1 name')).toHaveValue('DATABASE_URL');
    await page.getByLabel('Variable 1 value').fill('postgres://new');

    // Add a brand-new var (PORT=8080) — becomes row 3.
    await page.getByRole('button', { name: 'Add variable' }).click();
    await page.getByLabel('Variable 3 name').fill('PORT');
    await page.getByLabel('Variable 3 value').fill('8080');

    await page.getByRole('button', { name: copy.envSaveButton }).click();

    // Redeploy-reason toast (redeployed:true branch).
    await expect(page.getByText(copy.envSavedRedeploying)).toBeVisible();

    // The PATCH payload follows the write-only contract:
    //  - edited DATABASE_URL → value present
    //  - untouched API_KEY   → key only, NO value
    //  - new PORT            → value present
    expect(patchBody).not.toBeNull();
    const sent = (patchBody as { envVars: { key: string; value?: string }[] }).envVars;
    const byKey = Object.fromEntries(sent.map((e) => [e.key, e]));
    expect(byKey['DATABASE_URL']).toEqual({ key: 'DATABASE_URL', value: 'postgres://new' });
    expect(byKey['PORT']).toEqual({ key: 'PORT', value: '8080' });
    expect(byKey['API_KEY']).toEqual({ key: 'API_KEY' });
    expect('value' in byKey['API_KEY']!).toBe(false);
  });

  test('shows the "applies on first deploy" toast when there is no active deployment', async ({
    page,
  }) => {
    const detail = makeProjectDetail({
      id: PROJECT_ID,
      name: 'My App',
      envVars: [],
    });

    await mockBackend(page, { user: ownerUser, detail });

    await page.route('**/api/**', async (route) => {
      const req = route.request();
      if (req.method() === 'PATCH') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ...detail,
            envVars: [{ key: 'FEATURE_FLAG', hasValue: true }],
            redeploy: { redeployed: false, reason: 'NO_ACTIVE_DEPLOYMENT' },
          }),
        });
      }
      return route.fallback();
    });

    await gotoProject(page, `/projects/${PROJECT_ID}?tab=settings`);

    await page.getByRole('button', { name: 'Add variable' }).click();
    await page.getByLabel('Variable 1 name').fill('FEATURE_FLAG');
    await page.getByLabel('Variable 1 value').fill('on');
    await page.getByRole('button', { name: copy.envSaveButton }).click();

    await expect(page.getByText(copy.envSavedNoActive)).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// 4. Stop / resume
// ---------------------------------------------------------------------------

test.describe('stop / resume (authenticated)', () => {
  test('Stop flips the badge to Stopped', async ({ page }) => {
    const detail = makeProjectDetail({
      id: PROJECT_ID,
      name: 'My App',
      status: 'ACTIVE',
      liveUrl: 'https://my-app.example.com',
    });

    await mockBackend(page, { user: ownerUser, detail });

    // After stop, the invalidated `['project', id]` refetch must return STOPPED.
    // Register a detail override BEFORE the stop POST handler so the GET reflects
    // the new status once stop succeeds.
    let stopped = false;
    await page.route('**/api/**', async (route) => {
      const req = route.request();
      const path = new URL(req.url()).pathname;
      if (req.method() === 'POST' && /\/stop$/.test(path)) {
        stopped = true;
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ...detail, status: 'STOPPED', stoppedAt: '2026-06-10T11:00:00.000Z' }),
        });
      }
      if (req.method() === 'GET' && /^\/api\/projects\/[^/]+$/.test(path) && stopped) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ...detail, status: 'STOPPED', stoppedAt: '2026-06-10T11:00:00.000Z' }),
        });
      }
      return route.fallback();
    });

    await gotoProject(page, `/projects/${PROJECT_ID}`);

    // Starts Active with a Stop button.
    await expect(page.getByText(copy.statusActive).first()).toBeVisible();
    await page.getByRole('button', { name: copy.stopButton }).click();

    // Success toast + the badge flips to Stopped and the button becomes Resume.
    await expect(page.getByText(copy.stoppedToast)).toBeVisible();
    await expect(page.getByText(copy.statusStopped).first()).toBeVisible();
    await expect(page.getByRole('button', { name: copy.resumeButton })).toBeVisible();
  });

  test('Resume flips a stopped project back to Active', async ({ page }) => {
    const detail = makeProjectDetail({
      id: PROJECT_ID,
      name: 'My App',
      status: 'STOPPED',
      stoppedAt: '2026-06-10T11:00:00.000Z',
    });

    await mockBackend(page, { user: ownerUser, detail });

    let resumed = false;
    await page.route('**/api/**', async (route) => {
      const req = route.request();
      const path = new URL(req.url()).pathname;
      if (req.method() === 'POST' && /\/resume$/.test(path)) {
        resumed = true;
        // resumedBuild null → no navigation, just the "Project resumed" toast.
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ...detail, status: 'ACTIVE', stoppedAt: null, resumedBuild: null }),
        });
      }
      if (req.method() === 'GET' && /^\/api\/projects\/[^/]+$/.test(path) && resumed) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ...detail, status: 'ACTIVE', stoppedAt: null }),
        });
      }
      return route.fallback();
    });

    await gotoProject(page, `/projects/${PROJECT_ID}`);

    await expect(page.getByText(copy.statusStopped).first()).toBeVisible();
    await page.getByRole('button', { name: copy.resumeButton }).click();

    await expect(page.getByText(copy.resumedToast)).toBeVisible();
    await expect(page.getByText(copy.statusActive).first()).toBeVisible();
    await expect(page.getByRole('button', { name: copy.stopButton })).toBeVisible();
  });

  test('Stop is rejected with a clear toast while a build is in progress', async ({ page }) => {
    const detail = makeProjectDetail({
      id: PROJECT_ID,
      name: 'My App',
      status: 'ACTIVE',
    });

    await mockBackend(page, { user: ownerUser, detail });

    // The UI doesn't disable Stop on an in-flight build — the server enforces it
    // with 409 BUILD_IN_PROGRESS, which the header maps to a clearer toast.
    await page.route('**/api/**', async (route) => {
      const req = route.request();
      if (req.method() === 'POST' && /\/stop$/.test(new URL(req.url()).pathname)) {
        return route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'BUILD_IN_PROGRESS', message: 'A build is running' }),
        });
      }
      return route.fallback();
    });

    await gotoProject(page, `/projects/${PROJECT_ID}`);
    await page.getByRole('button', { name: copy.stopButton }).click();

    await expect(page.getByText("Can't stop — a build is running")).toBeVisible();
    // It stayed Active (no badge flip on the rejected stop).
    await expect(page.getByText(copy.statusActive).first()).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// 5. Preview environments
// ---------------------------------------------------------------------------

test.describe('preview environments (authenticated)', () => {
  test('lists PR previews with status badge + live URL, and tears one down', async ({ page }) => {
    const active = makePreview({
      id: 'preview_active',
      prNumber: 42,
      title: 'Add a shiny feature',
      headRef: 'feature/shiny',
      status: 'ACTIVE',
      liveUrl: 'https://pr-42.preview.example.com',
    });

    await mockBackend(page, {
      user: ownerUser,
      detail: makeProjectDetail({ id: PROJECT_ID, name: 'My App', previewsEnabled: true }),
      previews: [active],
    });

    const teardown = capturePost(
      page,
      /^\/api\/projects\/[^/]+\/previews\/[^/]+\/teardown$/,
      200,
      { ...active, status: 'TORN_DOWN', closedAt: '2026-06-10T12:00:00.000Z' },
    );

    await gotoProject(page, `/projects/${PROJECT_ID}?tab=previews`);

    // PR card: number, status badge (ACTIVE → "Active"), branch, title, live URL.
    await expect(page.getByText('PR #42')).toBeVisible();
    await expect(page.getByText('Add a shiny feature')).toBeVisible();
    await expect(page.getByText(copy.statusActive).first()).toBeVisible();
    await expect(page.getByRole('link', { name: /pr-42\.preview\.example\.com/ })).toBeVisible();

    // Tear down → confirm dialog → POST fires.
    await page.getByRole('button', { name: copy.previewTeardownButton }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(copy.previewTeardownConfirmTitle)).toBeVisible();
    await dialog.getByRole('button', { name: copy.previewTeardownButton }).click();

    await expect(page.getByText('Preview for PR #42 torn down.')).toBeVisible();

    const req = teardown.request();
    expect(req).not.toBeNull();
    expect(new URL(req!.url()).pathname).toContain('/previews/preview_active/teardown');
  });

  test('shows the disabled note + empty state when previews are off and none exist', async ({
    page,
  }) => {
    await mockBackend(page, {
      user: ownerUser,
      detail: makeProjectDetail({ id: PROJECT_ID, name: 'My App', previewsEnabled: false }),
      previews: [],
    });

    await gotoProject(page, `/projects/${PROJECT_ID}?tab=previews`);

    await expect(page.getByText(copy.previewsDisabledNote)).toBeVisible();
    await expect(page.getByText(copy.previewsEmptyTitle)).toBeVisible();
    // No teardown button when there are no previews.
    await expect(page.getByRole('button', { name: copy.previewTeardownButton })).toHaveCount(0);
  });
});
