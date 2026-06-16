import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useStopProject } from './useStopProject';

// Stop/resume go through the shared `api()` client, which calls the global
// `fetch`. We stub `fetch` per test (the api.test.ts pattern) and drive the
// mutation against a real QueryClient so we can assert the exact POST shape and
// that the right query keys are invalidated on success.

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

describe('useStopProject', () => {
  it('POSTs to /api/projects/:id/stop and returns the reshaped project', async () => {
    const project = { id: 'p1', status: 'STOPPED', stoppedAt: '2026-06-16T00:00:00.000Z' };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(project));
    vi.stubGlobal('fetch', fetchMock);

    const qc = new QueryClient();
    const { result } = renderHook(() => useStopProject(), { wrapper: wrapper(qc) });

    const data = await result.current.mutateAsync('p1');

    expect(data).toEqual(project);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/projects/p1/stop');
    expect((init as RequestInit).method).toBe('POST');
    // The CSRF gate (requireXRequestedWith) rejects mutations without this header.
    expect(new Headers((init as RequestInit).headers).get('X-Requested-With')).toBe(
      'XMLHttpRequest',
    );
  });

  it('invalidates project, projects, and activity on success (not project-builds)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ id: 'p1', status: 'STOPPED' })));

    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useStopProject(), { wrapper: wrapper(qc) });

    await result.current.mutateAsync('p1');

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const keys = invalidate.mock.calls.map((c) => c[0]?.queryKey);
    expect(keys).toContainEqual(['project', 'p1']);
    expect(keys).toContainEqual(['projects']);
    expect(keys).toContainEqual(['activity']);
    // Stopping never queues a build, so the builds list must NOT be invalidated.
    expect(keys).not.toContainEqual(['project-builds', 'p1']);
  });

  it('propagates an ApiError (e.g. 409 BUILD_IN_PROGRESS) to the caller', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(
          { error: 'BUILD_IN_PROGRESS', message: 'a build is running' },
          { status: 409 },
        ),
      ),
    );

    const qc = new QueryClient();
    const { result } = renderHook(() => useStopProject(), { wrapper: wrapper(qc) });

    await expect(result.current.mutateAsync('p1')).rejects.toMatchObject({
      status: 409,
      code: 'BUILD_IN_PROGRESS',
    });
  });
});
