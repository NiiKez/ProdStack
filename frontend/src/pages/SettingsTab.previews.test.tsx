import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@/components/ui/Toast';
import { SettingsTab } from './ProjectDetail';
import type { ProjectDetail } from '@/types/api';

// The Settings "Preview environments" toggle must flow into the PATCH payload.
// We stub fetch (shared api() client), flip the switch, Save, and assert the
// request body — "test logic not markup".

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function project(over: Partial<ProjectDetail> = {}): ProjectDetail {
  return {
    id: 'p1',
    name: 'demo',
    slug: 'demo',
    githubRepoFullName: 'octo/demo',
    branch: 'main',
    liveUrl: null,
    containerAppName: 'octo-demo',
    autoDeploy: true,
    previewsEnabled: false,
    status: 'ACTIVE',
    stoppedAt: null,
    createdAt: '2026-06-17T00:00:00.000Z',
    updatedAt: '2026-06-17T00:00:00.000Z',
    latestBuild: null,
    activeDeployment: null,
    builds: [],
    ...over,
  };
}

function renderTab(p: ProjectDetail) {
  const qc = new QueryClient();
  return render(
    createElement(
      QueryClientProvider,
      { client: qc },
      createElement(
        ToastProvider,
        null,
        createElement(MemoryRouter, null, createElement(SettingsTab, { project: p })),
      ) as ReactNode,
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('SettingsTab — preview toggle', () => {
  it('includes previewsEnabled in the PATCH when the toggle is flipped + saved', async () => {
    const p = project({ previewsEnabled: false });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ...p, previewsEnabled: true }));
    vi.stubGlobal('fetch', fetchMock);

    renderTab(p);

    fireEvent.click(screen.getByRole('switch', { name: /preview environments/i }));
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/projects/p1');
    expect((init as RequestInit).method).toBe('PATCH');
    const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
    expect(body.previewsEnabled).toBe(true);
  });
});
