import { expect, test } from '@playwright/test';
import { mockBackend } from './fixtures';

/**
 * Unauthenticated flows. `GET /api/auth/me` replies 401. That 401 flows through
 * the `api()` wrapper's global unauthorized handler (set in main.tsx), which
 * hard-redirects any non-root path to `/?session=expired` — this preempts
 * RequireAuth's own `/?next=` <Navigate>. Either way the user lands on the
 * public Landing view with the sign-in CTA.
 *
 * Resilient selectors only: the sign-in CTA is asserted by its button ROLE +
 * accessible name ("Sign in with GitHub"), and the dashboard heading
 * ("Projects") is asserted ABSENT. No CSS classes / DOM structure.
 */
test.describe('unauthenticated', () => {
  test.beforeEach(async ({ page }) => {
    // user: null → /api/auth/me returns 401.
    await mockBackend(page, { user: null });
  });

  test('landing page shows the GitHub sign-in CTA', async ({ page }) => {
    await page.goto('/');

    const signIn = page.getByRole('button', { name: 'Sign in with GitHub' });
    await expect(signIn).toBeVisible();

    // The headline is part of the public marketing view.
    await expect(page.getByRole('heading', { name: 'Push to deploy.' })).toBeVisible();
  });

  test('visiting /dashboard while signed out lands on the sign-in view, not the dashboard', async ({
    page,
  }) => {
    await page.goto('/dashboard');

    // Redirected to Landing — the sign-in CTA is present...
    const signIn = page.getByRole('button', { name: 'Sign in with GitHub' });
    await expect(signIn).toBeVisible();

    // ...and the authenticated dashboard content is NOT rendered.
    await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'New Project' })).toHaveCount(0);

    // The 401 handler hard-redirected us to the public landing route.
    await expect(page).toHaveURL(/\?session=expired/);
  });
});
