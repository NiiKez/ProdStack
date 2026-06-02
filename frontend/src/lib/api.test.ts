import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApiError, api, setUnauthorizedHandler } from '@/lib/api';

// Helpers for building Response objects (jsdom provides Response/Headers).
function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function textResponse(body: string, init: ResponseInit = {}) {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/plain' },
    ...init,
  });
}

/** Read the headers of the Nth fetch call as a plain lowercased map. */
function fetchHeaders(callIndex = 0): Record<string, string> {
  const call = vi.mocked(fetch).mock.calls[callIndex];
  const init = call?.[1] as RequestInit | undefined;
  const out: Record<string, string> = {};
  new Headers(init?.headers).forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  // Reset the module-level unauthorized handler so spies don't leak across tests.
  setUnauthorizedHandler(() => {});
});

describe('api() request shaping', () => {
  it('builds the URL as apiBaseUrl + path (default base is empty → url === path)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ok: true })));

    await api('/api/projects');

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe('/api/projects');
  });

  it('always sends credentials: include', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ok: true })));

    await api('/x');

    const init = vi.mocked(fetch).mock.calls[0]![1] as RequestInit;
    expect(init.credentials).toBe('include');
  });

  it('defaults the method to GET and does NOT add X-Requested-With for GET', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ok: true })));

    await api('/x');

    const init = vi.mocked(fetch).mock.calls[0]![1] as RequestInit;
    expect(init.method).toBeUndefined(); // api() never sets a method itself for GET
    expect(fetchHeaders()['x-requested-with']).toBeUndefined();
  });

  it.each(['HEAD', 'OPTIONS'])(
    'does NOT add X-Requested-With for safe method %s',
    async (method) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));

      await api('/x', { method });

      expect(fetchHeaders()['x-requested-with']).toBeUndefined();
    },
  );

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    'adds X-Requested-With: XMLHttpRequest for mutation %s',
    async (method) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ok: true })));

      await api('/x', { method });

      expect(fetchHeaders()['x-requested-with']).toBe('XMLHttpRequest');
    },
  );

  it('uppercases a lowercase method before deciding mutation vs safe', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ok: true })));

    await api('/x', { method: 'post' });

    expect(fetchHeaders()['x-requested-with']).toBe('XMLHttpRequest');
  });

  it('sets Content-Type: application/json when a body is present and none is set', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ok: true })));

    await api('/x', { method: 'POST', body: JSON.stringify({ a: 1 }) });

    expect(fetchHeaders()['content-type']).toBe('application/json');
  });

  it('does NOT override a caller-supplied Content-Type', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ok: true })));

    await api('/x', {
      method: 'POST',
      body: 'a=1',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    expect(fetchHeaders()['content-type']).toBe('application/x-www-form-urlencoded');
  });

  it('does NOT set Content-Type when there is no body (even for a mutation)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ok: true })));

    await api('/x', { method: 'POST' });

    expect(fetchHeaders()['content-type']).toBeUndefined();
  });
});

describe('api() success responses', () => {
  it('returns parsed JSON for an application/json success body', async () => {
    const payload = { id: 1, name: 'demo' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(payload)));

    const result = await api<typeof payload>('/x');

    expect(result).toEqual(payload);
  });

  it('returns raw text for a non-JSON success body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(textResponse('plain text')));

    const result = await api<string>('/x');

    expect(result).toBe('plain text');
  });

  it('resolves to undefined for 204 No Content (no body read)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));

    const result = await api('/x', { method: 'DELETE' });

    expect(result).toBeUndefined();
  });
});

describe('api() error responses', () => {
  it('throws ApiError mapping {error,message} → code/message and keeps body as details', async () => {
    const errBody = { error: 'BAD_INPUT', message: 'name is required' };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(errBody, { status: 400 })),
    );

    await expect(api('/x', { method: 'POST', body: '{}' })).rejects.toMatchObject({
      name: 'ApiError',
      status: 400,
      code: 'BAD_INPUT',
      message: 'name is required',
      details: errBody,
    });
  });

  it('falls back to code ERROR and statusText when the error body omits fields', async () => {
    // Empty JSON object → no error/message fields.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({}), {
          status: 503,
          statusText: 'Service Unavailable',
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const err = (await api('/x').catch((e) => e)) as ApiError;

    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(503);
    expect(err.code).toBe('ERROR');
    expect(err.message).toBe('Service Unavailable');
    expect(err.details).toEqual({});
  });

  it('swallows a malformed JSON body (JSON content-type) to {} and surfaces code ERROR', async () => {
    // Body declares JSON but is not parseable → res.json() rejects → caught to {}.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('not json {{{', {
          status: 500,
          statusText: 'Internal Server Error',
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const err = (await api('/x').catch((e) => e)) as ApiError;

    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(500);
    expect(err.code).toBe('ERROR');
    expect(err.message).toBe('Internal Server Error');
    expect(err.details).toEqual({});
  });

  it('uses the text body as details for a non-JSON error response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('upstream exploded', {
          status: 502,
          statusText: 'Bad Gateway',
          headers: { 'content-type': 'text/plain' },
        }),
      ),
    );

    const err = (await api('/x').catch((e) => e)) as ApiError;

    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(502);
    expect(err.code).toBe('ERROR');
    expect(err.message).toBe('Bad Gateway');
    expect(err.details).toBe('upstream exploded');
  });
});

describe('api() 401 handling', () => {
  it('calls the registered unauthorized handler exactly once and throws ApiError(401)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
    const handler = vi.fn();
    setUnauthorizedHandler(handler);

    const err = (await api('/x').catch((e) => e)) as ApiError;

    expect(handler).toHaveBeenCalledTimes(1);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(401);
    expect(err.code).toBe('UNAUTHORIZED');
    expect(err.message).toBe('Session expired');
  });

  it('does not read the body on a 401 (handler fires before any parse)', async () => {
    // A 401 with a malformed JSON body must NOT cause a parse error — the 401
    // branch returns before the body is touched.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('not json {{{', {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    setUnauthorizedHandler(() => {});

    await expect(api('/x')).rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
  });
});

describe('api() with a non-empty apiBaseUrl', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('@/env');
  });

  it('prefixes the configured apiBaseUrl onto the path', async () => {
    // Mock @/env to a real base URL and re-import api() (after resetting the
    // module registry) so the fresh api() module binds the mocked env.
    vi.resetModules();
    vi.doMock('@/env', () => ({ env: { apiBaseUrl: 'https://api.example.test' } }));
    const { api: apiWithBase } = await import('@/lib/api');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ok: true })));

    await apiWithBase('/api/projects');

    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe('https://api.example.test/api/projects');
  });
});
