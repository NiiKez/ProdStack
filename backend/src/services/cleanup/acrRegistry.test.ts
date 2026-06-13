// Tests for the ACR data-plane REST client (M6 image GC). The module is a
// dependency-free wrapper over the `*.azurecr.io` data-plane API using the Node
// 20 global `fetch` + HTTP Basic auth. It issues live registry reads AND a
// manifest DELETE, so a wrong/encoded delete can make a deployed app
// un-pullable — these tests pin the URL/method/auth each function emits and how
// it handles success/already-gone/error responses.
//
// `authHeader()` throws if ACR_USERNAME/ACR_PASSWORD are unset and
// `registryHost()` reads ACR_NAME ?? 'prodstack'. Those optional vars are UNSET
// in the test env, so we set them via `vi.hoisted` BEFORE env.ts loads (ESM
// hoists `import`s above plain statements, so a plain assignment is too late).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.ACR_NAME = 'testacr';
  process.env.ACR_USERNAME = 'acruser';
  process.env.ACR_PASSWORD = 'acrpass';
});

const {
  listRepositories,
  listTags,
  getTagDigest,
  deleteManifestByTag,
  hasAcrCredentials,
} = await import('./acrRegistry.js');

const HOST = 'https://testacr.azurecr.io';
// base64('acruser:acrpass')
const EXPECTED_AUTH = `Basic ${Buffer.from('acruser:acrpass').toString('base64')}`;

/** Build a fake Response-like object. Node 20 has a global `Headers`. */
function fakeResponse(opts: {
  ok?: boolean;
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  json?: unknown;
}): Response {
  const status = opts.status ?? 200;
  return {
    ok: opts.ok ?? (status >= 200 && status < 300),
    status,
    statusText: opts.statusText ?? '',
    headers: new Headers(opts.headers ?? {}),
    json: async () => opts.json,
  } as unknown as Response;
}

/** The global fetch mock, (re)installed in beforeEach. */
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The (url, init) of the Nth (0-based) fetch call. */
function call(n: number): [string, RequestInit | undefined] {
  return fetchMock.mock.calls[n] as [string, RequestInit | undefined];
}

describe('deleteManifestByTag', () => {
  const DIGEST = 'sha256:abc123abc123abc123abc123abc123abc123abc123abc123abc123abc123abcd';

  it('DELETEs the provided digest with a RAW colon (not %3A) + Basic auth', async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse({ status: 202, statusText: 'Accepted' }));

    await deleteManifestByTag('myrepo', 'v1', DIGEST);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = call(0);
    // The colon in sha256:... MUST be raw — encoding it to %3A 404s the
    // reference, which the 404-is-success branch turns into a silent no-op.
    expect(url).toBe(`${HOST}/v2/myrepo/manifests/${DIGEST}`);
    expect(url).toContain('sha256:abc123');
    expect(url).not.toContain('%3A');
    expect(init?.method).toBe('DELETE');
    expect((init?.headers as Record<string, string>).Authorization).toBe(EXPECTED_AUTH);
  });

  it('resolves on 202 Accepted', async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse({ status: 202, statusText: 'Accepted' }));
    await expect(deleteManifestByTag('r', 't', DIGEST)).resolves.toBeUndefined();
  });

  it('resolves on 200 OK', async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse({ status: 200, statusText: 'OK' }));
    await expect(deleteManifestByTag('r', 't', DIGEST)).resolves.toBeUndefined();
  });

  it('resolves on 404 (already gone is success, no throw)', async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResponse({ ok: false, status: 404, statusText: 'Not Found' }),
    );
    await expect(deleteManifestByTag('r', 't', DIGEST)).resolves.toBeUndefined();
  });

  it('rejects on 500', async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResponse({ ok: false, status: 500, statusText: 'Internal Server Error' }),
    );
    await expect(deleteManifestByTag('r', 't', DIGEST)).rejects.toThrow(/manifest delete failed/i);
  });

  it('without a digest: GETs the tag digest first, then DELETEs it (two calls)', async () => {
    const resolved = 'sha256:deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    fetchMock
      .mockResolvedValueOnce(fakeResponse({ status: 200, json: { tag: { digest: resolved } } }))
      .mockResolvedValueOnce(fakeResponse({ status: 202, statusText: 'Accepted' }));

    await deleteManifestByTag('myrepo', 'mytag');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // 1st: getTagDigest GET
    const [getUrl, getInit] = call(0);
    expect(getUrl).toBe(`${HOST}/acr/v1/myrepo/_tags/mytag`);
    expect(getInit?.method).toBeUndefined(); // a GET (no explicit method)
    // 2nd: DELETE of the resolved digest, raw colon
    const [delUrl, delInit] = call(1);
    expect(delUrl).toBe(`${HOST}/v2/myrepo/manifests/${resolved}`);
    expect(delUrl).not.toContain('%3A');
    expect(delInit?.method).toBe('DELETE');
  });
});

describe('getTagDigest', () => {
  it('GETs /acr/v1/<repo>/_tags/<tag> and returns the digest', async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResponse({ status: 200, json: { tag: { digest: 'sha256:cafe' } } }),
    );
    const digest = await getTagDigest('myrepo', 'v2');
    expect(digest).toBe('sha256:cafe');
    const [url, init] = call(0);
    expect(url).toBe(`${HOST}/acr/v1/myrepo/_tags/v2`);
    expect((init?.headers as Record<string, string>).Authorization).toBe(EXPECTED_AUTH);
  });

  it('throws when the response has no digest', async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse({ status: 200, json: { tag: {} } }));
    await expect(getTagDigest('r', 't')).rejects.toThrow(/no digest/i);
  });
});

describe('listTags', () => {
  it('GETs /acr/v1/<repo>/_tags and parses into AcrTag[]', async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResponse({
        status: 200,
        json: {
          tags: [
            { name: 'latest', digest: 'sha256:aaa', lastUpdateTime: '2026-06-01T00:00:00Z' },
            { name: 'v1', digest: 'sha256:bbb', lastUpdateTime: '2026-05-01T00:00:00Z' },
          ],
        },
      }),
    );

    const tags = await listTags('myrepo');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = call(0);
    expect(url).toBe(`${HOST}/acr/v1/myrepo/_tags?orderby=timedesc&n=500`);
    expect((init?.headers as Record<string, string>).Authorization).toBe(EXPECTED_AUTH);
    expect(tags).toEqual([
      { name: 'latest', digest: 'sha256:aaa', lastUpdateTime: '2026-06-01T00:00:00Z' },
      { name: 'v1', digest: 'sha256:bbb', lastUpdateTime: '2026-05-01T00:00:00Z' },
    ]);
  });

  it('follows the Link rel="next" header and concatenates pages', async () => {
    fetchMock
      .mockResolvedValueOnce(
        fakeResponse({
          status: 200,
          headers: { Link: '</acr/v1/myrepo/_tags?last=v1&n=500>; rel="next"' },
          json: { tags: [{ name: 'latest', digest: 'sha256:aaa', lastUpdateTime: 't1' }] },
        }),
      )
      .mockResolvedValueOnce(
        fakeResponse({
          status: 200,
          json: { tags: [{ name: 'v1', digest: 'sha256:bbb', lastUpdateTime: 't2' }] },
        }),
      );

    const tags = await listTags('myrepo');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // 2nd call follows the host-relative next path.
    expect(call(1)[0]).toBe(`${HOST}/acr/v1/myrepo/_tags?last=v1&n=500`);
    expect(tags.map((t) => t.name)).toEqual(['latest', 'v1']);
  });

  it('keeps the / in a nested repo path unencoded (per-segment encoding)', async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse({ status: 200, json: { tags: [] } }));
    await listTags('user/proj');
    const url = call(0)[0];
    expect(url).toBe(`${HOST}/acr/v1/user/proj/_tags?orderby=timedesc&n=500`);
    expect(url).not.toContain('%2F');
  });

  it('throws on a non-ok response', async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResponse({ ok: false, status: 403, statusText: 'Forbidden' }),
    );
    await expect(listTags('r')).rejects.toThrow(/_tags failed/i);
  });
});

describe('listRepositories', () => {
  it('GETs /acr/v1/_catalog and parses repositories[]', async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResponse({ status: 200, json: { repositories: ['repo-a', 'repo-b'] } }),
    );

    const repos = await listRepositories();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = call(0);
    expect(url).toBe(`${HOST}/acr/v1/_catalog?n=500`);
    expect((init?.headers as Record<string, string>).Authorization).toBe(EXPECTED_AUTH);
    expect(repos).toEqual(['repo-a', 'repo-b']);
  });

  it('follows the Link rel="next" header and concatenates pages', async () => {
    fetchMock
      .mockResolvedValueOnce(
        fakeResponse({
          status: 200,
          headers: { Link: '</acr/v1/_catalog?last=repo-a&n=500>; rel="next"' },
          json: { repositories: ['repo-a'] },
        }),
      )
      .mockResolvedValueOnce(fakeResponse({ status: 200, json: { repositories: ['repo-b'] } }));

    const repos = await listRepositories();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(call(1)[0]).toBe(`${HOST}/acr/v1/_catalog?last=repo-a&n=500`);
    expect(repos).toEqual(['repo-a', 'repo-b']);
  });

  it('throws on a non-ok response', async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResponse({ ok: false, status: 401, statusText: 'Unauthorized' }),
    );
    await expect(listRepositories()).rejects.toThrow(/_catalog failed/i);
  });
});

describe('hasAcrCredentials', () => {
  it('returns true when ACR_USERNAME and ACR_PASSWORD are set', () => {
    expect(hasAcrCredentials()).toBe(true);
  });
});
