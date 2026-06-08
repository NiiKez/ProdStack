import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Landing, { demoLoginUrl, githubBeginUrl } from './Landing';
import { ToastProvider } from '@/components/ui/Toast';

// "Test logic not markup": the landing CTAs use full-page navigation, so the
// testable unit is the URL each handler builds (the demo button mirrors the
// GitHub sign-in's `next`-threading). We assert the encoded URLs, not the DOM.

describe('Landing demo-launch URL', () => {
  it('navigates to the GET demo-login route with no query when there is no `next`', () => {
    expect(demoLoginUrl()).toBe('/api/auth/demo-login');
    expect(demoLoginUrl(null)).toBe('/api/auth/demo-login');
    expect(demoLoginUrl('')).toBe('/api/auth/demo-login');
  });

  it('appends an encoded `next` so a deep link survives the demo round-trip', () => {
    expect(demoLoginUrl('/dashboard')).toBe('/api/auth/demo-login?next=%2Fdashboard');
    expect(demoLoginUrl('/projects/abc?tab=builds')).toBe(
      '/api/auth/demo-login?next=%2Fprojects%2Fabc%3Ftab%3Dbuilds',
    );
  });
});

describe('Landing GitHub sign-in URL', () => {
  it('navigates to the OAuth begin route with no query when there is no `next`', () => {
    expect(githubBeginUrl()).toBe('/api/auth/github/begin');
    expect(githubBeginUrl(null)).toBe('/api/auth/github/begin');
  });

  it('appends an encoded `next`', () => {
    expect(githubBeginUrl('/dashboard')).toBe('/api/auth/github/begin?next=%2Fdashboard');
  });
});

describe('Landing buttons wire to the right navigation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function renderLanding(next: string) {
    const assign = vi.fn();
    vi.stubGlobal('location', { assign } as unknown as Location);
    render(
      <MemoryRouter initialEntries={[`/?next=${encodeURIComponent(next)}`]}>
        <ToastProvider>
          <Landing />
        </ToastProvider>
      </MemoryRouter>,
    );
    return assign;
  }

  it('"Launch demo" navigates to the demo-login URL with the threaded `next`', () => {
    const assign = renderLanding('/projects/abc');
    fireEvent.click(screen.getByRole('button', { name: /launch demo/i }));
    expect(assign).toHaveBeenCalledWith(demoLoginUrl('/projects/abc'));
  });

  it('"Sign in with GitHub" navigates to the OAuth begin URL with the threaded `next` (handlers not swapped)', () => {
    const assign = renderLanding('/projects/abc');
    fireEvent.click(screen.getByRole('button', { name: /sign in with github/i }));
    expect(assign).toHaveBeenCalledWith(githubBeginUrl('/projects/abc'));
  });
});
