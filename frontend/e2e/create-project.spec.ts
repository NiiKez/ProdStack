import { expect, test, type Page } from '@playwright/test';
import { makeProject, mockBackend, ownerUser } from './fixtures';

/**
 * Create-project flow from the dashboard. Authenticated (`/api/auth/me` → user).
 * The modal is a Radix Dialog (role="dialog"); fields are targeted by their
 * visible <label> text, the submit by its accessible name. Outcomes (success
 * toast + modal close, or inline field error) are asserted by visible copy,
 * never by markup.
 *
 * The modal defaults to the **repo picker** (a searchable list of the user's
 * GitHub repos from `GET /api/github/repos`, stubbed in `fixtures.ts`). It can
 * be toggled to **manual URL entry** ("Paste a URL instead"), and falls back to
 * manual automatically when the repos query errors. Both paths are covered.
 *
 * Note on the error test: the form runs the same repo-URL regex client-side as
 * the server, so to reach the SERVER `INVALID_REPO_URL` branch we submit a URL
 * that PASSES the client regex (`https://github.com/...`) and let the mocked
 * POST reject it.
 */

const VALID_REPO_URL = 'https://github.com/octocat/my-new-app';

/** Open the dashboard and the "Create a new project" modal. */
async function openCreateModal(page: Page) {
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible();

  // There can be two "New Project" buttons (header + empty state). The header
  // one is always present; click the first.
  await page.getByRole('button', { name: 'New Project' }).first().click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Create a new project')).toBeVisible();
  return dialog;
}

test.describe('create project (authenticated)', () => {
  test('picks a repo from the list and shows the success outcome', async ({ page }) => {
    await mockBackend(page, { user: ownerUser, projects: [] });

    // Override POST /api/projects → 201 with the created project. Registered
    // after mockBackend so it intercepts first.
    const created = makeProject({
      id: 'proj_created',
      name: 'My New App',
      githubRepoFullName: 'octocat/my-new-app',
    });
    await page.route('**/api/projects', async (route) => {
      if (route.request().method() === 'POST') {
        const payload = route.request().postDataJSON() as Record<string, unknown>;
        // Selecting the repo fills repoUrl + branch (defaultBranch 'main') +
        // the derived name; the spec edits the name to "My New App".
        expect(payload).toMatchObject({
          repoUrl: VALID_REPO_URL,
          branch: 'main',
          name: 'My New App',
        });
        return route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify(created),
        });
      }
      return route.fallback();
    });

    const dialog = await openCreateModal(page);

    // The picker is the default mode: the fetched repos render as a list.
    // Filter to the target repo, then select it.
    await dialog.getByLabel('Search repositories').fill('my-new-app');
    await dialog.getByRole('button', { name: /octocat\/my-new-app/ }).click();

    // Selecting fills the form. Tweak the name to the asserted value.
    await dialog.getByLabel('Project name').fill('My New App');

    await dialog.getByRole('button', { name: 'Create project' }).click();

    // Success toast copy from NewProjectModal.onSubmit.
    await expect(
      page.getByText('Project created. Push a commit to deploy.'),
    ).toBeVisible();

    // Modal closes on success (onOpenChange(false)).
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // And the app navigates to the new project's detail page.
    await expect(page).toHaveURL(/\/projects\/proj_created$/);
  });

  test('falls back to manual URL entry and submits', async ({ page }) => {
    // Repos endpoint errors → the modal auto-switches to manual URL entry.
    await mockBackend(page, { user: ownerUser, projects: [], repos: 'error' });

    const created = makeProject({
      id: 'proj_created',
      name: 'My New App',
      githubRepoFullName: 'octocat/my-new-app',
    });
    await page.route('**/api/projects', async (route) => {
      if (route.request().method() === 'POST') {
        const payload = route.request().postDataJSON() as Record<string, unknown>;
        expect(payload).toMatchObject({
          repoUrl: VALID_REPO_URL,
          branch: 'main',
          name: 'My New App',
        });
        return route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify(created),
        });
      }
      return route.fallback();
    });

    const dialog = await openCreateModal(page);

    // The fallback note + the manual URL input are shown.
    await expect(
      dialog.getByText("Couldn't load your repos — paste a URL instead."),
    ).toBeVisible();

    await dialog.getByLabel('GitHub repo URL').fill(VALID_REPO_URL);
    await dialog.getByLabel('Branch').fill('main');
    await dialog.getByLabel('Project name').fill('My New App');

    await dialog.getByRole('button', { name: 'Create project' }).click();

    await expect(
      page.getByText('Project created. Push a commit to deploy.'),
    ).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page).toHaveURL(/\/projects\/proj_created$/);
  });

  test('toggles from the picker to manual URL entry on demand', async ({ page }) => {
    await mockBackend(page, { user: ownerUser, projects: [] });

    const dialog = await openCreateModal(page);

    // Picker is the default; switch to manual via the link.
    await expect(dialog.getByLabel('Search repositories')).toBeVisible();
    await dialog.getByRole('button', { name: /Paste a URL instead/ }).click();

    // Manual URL input is now available.
    await expect(dialog.getByLabel('GitHub repo URL')).toBeVisible();

    // And we can go back to the picker.
    await dialog.getByRole('button', { name: 'Pick from your repositories' }).click();
    await expect(dialog.getByLabel('Search repositories')).toBeVisible();
  });

  test('shows the inline field error when the server rejects the repo URL', async ({
    page,
  }) => {
    await mockBackend(page, { user: ownerUser, projects: [] });

    // Override POST → 400 INVALID_REPO_URL. `error` is the code the api client
    // surfaces as ApiError.code → mapped to inline repoUrl copy.
    await page.route('**/api/projects', async (route) => {
      if (route.request().method() === 'POST') {
        return route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'INVALID_REPO_URL', message: 'bad repo' }),
        });
      }
      return route.fallback();
    });

    const dialog = await openCreateModal(page);

    // Use the manual path for a deterministic repoUrl that passes the client
    // regex but is rejected server-side.
    await dialog.getByRole('button', { name: /Paste a URL instead/ }).click();
    await dialog.getByLabel('GitHub repo URL').fill(VALID_REPO_URL);
    await dialog.getByLabel('Branch').fill('main');
    await dialog.getByLabel('Project name').fill('My New App');

    await dialog.getByRole('button', { name: 'Create project' }).click();

    // Inline field-level error copy from mapApiError(INVALID_REPO_URL).
    await expect(
      dialog.getByText("That doesn't look like a GitHub repo URL."),
    ).toBeVisible();

    // The modal stays open on failure (no navigation, no success toast).
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(
      page.getByText('Project created. Push a commit to deploy.'),
    ).toHaveCount(0);
  });
});
