import { expect, test } from '@playwright/test';
import { mockBackend, ownerUser, sampleProjects } from './fixtures';

/**
 * Authenticated dashboard. `GET /api/auth/me` → a valid user so `RequireAuth`
 * renders the gated routes; `GET /api/projects` → the list under test.
 *
 * Resilient selectors: project names are asserted via their link/heading
 * accessible names (each card is an anchor whose visible text starts with the
 * project name) and the empty state via its visible copy. No classes/markup.
 */
test.describe('dashboard (authenticated)', () => {
  test('renders both projects from the list endpoint', async ({ page }) => {
    await mockBackend(page, { user: ownerUser, projects: sampleProjects });
    await page.goto('/dashboard');

    // Page shell loaded (lazy chunk + layout).
    await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible();

    // Each project card is a heading bearing the project name...
    await expect(
      page.getByRole('heading', { name: 'Alpha Service' }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Beta Worker' })).toBeVisible();

    // ...and each card is also a navigable link to its detail page.
    await expect(page.getByRole('link', { name: /Alpha Service/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /Beta Worker/ })).toBeVisible();

    // The repo identifiers render too.
    await expect(page.getByText('octocat/alpha-service')).toBeVisible();
    await expect(page.getByText('octocat/beta-worker')).toBeVisible();
  });

  test('shows the empty state when there are no projects', async ({ page }) => {
    await mockBackend(page, { user: ownerUser, projects: [] });
    await page.goto('/dashboard');

    await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible();

    // Empty-state copy from <EmptyState title=... description=... />.
    await expect(page.getByText('No projects yet')).toBeVisible();
    await expect(
      page.getByText('Create your first project to start deploying.'),
    ).toBeVisible();

    // No project links rendered.
    await expect(page.getByRole('heading', { name: 'Alpha Service' })).toHaveCount(0);
  });
});
