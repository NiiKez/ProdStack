import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useResumeProject } from './useResumeProject';

// Same setup as useStopProject.test: stub the global `fetch` and drive the
// mutation against a real QueryClient to assert the POST shape, the
// `resumedBuild` passthrough, and the invalidated query keys on success.

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function wrapper(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('useResumeProject', () => {
  it('POSTs to /api/projects/:id/resume and returns the project + resumedBuild', async () => {
    const payload = { id: 'p1', status: 'ACTIVE', resumedBuild: { id: 'b9' } };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(payload));
    vi.stubGlobal('fetch', fetchMock);

    const qc = new QueryClient();
    const { result } = renderHook(() => useResumeProject(), { wrapper: wrapper(qc) });

    const data = await result.current.mutateAsync('p1');

    expect(data).toEqual(payload);
    expect(data.resumedBuild).toEqual({ id: 'b9' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/projects/p1/resume');
    expect((init as RequestInit).method).toBe('POST');
    // The CSRF gate (requireXRequestedWith) rejects mutations without this header.
    expect(new Headers((init as RequestInit).headers).get('X-Requested-With')).toBe(
      'XMLHttpRequest',
    );
  });

  it('passes through a null resumedBuild (auto-deploy off / no commit)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ id: 'p1', status: 'ACTIVE', resumedBuild: null })),
    );

    const qc = new QueryClient();
    const { result } = renderHook(() => useResumeProject(), { wrapper: wrapper(qc) });

    const data = await result.current.mutateAsync('p1');
    expect(data.resumedBuild).toBeNull();
  });

  it('invalidates project, project-builds, projects, and activity on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ id: 'p1', status: 'ACTIVE', resumedBuild: null })),
    );

    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useResumeProject(), { wrapper: wrapper(qc) });

    await result.current.mutateAsync('p1');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const keys = invalidate.mock.calls.map((c) => c[0]?.queryKey);
    expect(keys).toContainEqual(['project', 'p1']);
    // Resume can queue a build, so the builds list IS invalidated (unlike stop).
    expect(keys).toContainEqual(['project-builds', 'p1']);
    expect(keys).toContainEqual(['projects']);
    expect(keys).toContainEqual(['activity']);
  });
});
