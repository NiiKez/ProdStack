import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { previewsRefetchInterval, usePreviews, useTeardownPreview } from './usePreviews';
import type { PreviewSummary } from '@/types/api';

// Previews go through the shared `api()` client (global `fetch`). Stub fetch per
// test and drive the hooks against a real QueryClient — assert the GET unwraps
// `{ previews }`, the teardown POSTs with the CSRF header, and the right keys
// are invalidated.

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

describe('usePreviews', () => {
  it('GETs the project previews and unwraps the { previews } envelope', async () => {
    const previews = [{ id: 'pv1', prNumber: 7, status: 'ACTIVE' }];
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ previews }));
    vi.stubGlobal('fetch', fetchMock);

    const qc = new QueryClient();
    const { result } = renderHook(() => usePreviews('p1'), { wrapper: wrapper(qc) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(previews);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/projects/p1/previews');
  });
});

describe('previewsRefetchInterval', () => {
  const row = (status: PreviewSummary['status']) => ({ status }) as PreviewSummary;

  it('polls every 5s while any preview is PENDING', () => {
    expect(previewsRefetchInterval([row('ACTIVE'), row('PENDING')])).toBe(5_000);
  });

  it('stops polling once no preview is PENDING', () => {
    expect(previewsRefetchInterval([row('ACTIVE'), row('FAILED'), row('TORN_DOWN')])).toBe(false);
  });

  it('does not poll for an empty / undefined list', () => {
    expect(previewsRefetchInterval([])).toBe(false);
    expect(previewsRefetchInterval(undefined)).toBe(false);
  });
});

describe('useTeardownPreview', () => {
  it('POSTs to the teardown route with the CSRF header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'pv1', status: 'TORN_DOWN' }));
    vi.stubGlobal('fetch', fetchMock);

    const qc = new QueryClient();
    const { result } = renderHook(() => useTeardownPreview('p1'), { wrapper: wrapper(qc) });

    const data = await result.current.mutateAsync('pv1');

    expect(data).toMatchObject({ id: 'pv1', status: 'TORN_DOWN' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/projects/p1/previews/pv1/teardown');
    expect((init as RequestInit).method).toBe('POST');
    expect(new Headers((init as RequestInit).headers).get('X-Requested-With')).toBe(
      'XMLHttpRequest',
    );
  });

  it('invalidates the previews + project queries on success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ id: 'pv1', status: 'TORN_DOWN' })));

    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useTeardownPreview('p1'), { wrapper: wrapper(qc) });

    await result.current.mutateAsync('pv1');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const keys = invalidate.mock.calls.map((c) => c[0]?.queryKey);
    expect(keys).toContainEqual(['project-previews', 'p1']);
    expect(keys).toContainEqual(['project', 'p1']);
  });
});
