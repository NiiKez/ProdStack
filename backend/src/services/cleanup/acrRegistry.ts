/**
 * Azure Container Registry data-plane REST client (M6 image GC).
 *
 * A thin, dependency-free wrapper over the ACR data-plane API using the Node 20
 * global `fetch` + HTTP Basic auth from the ACR admin credentials
 * (`ACR_USERNAME` / `ACR_PASSWORD`, already in env.ts — the same creds kaniko
 * pushes with). We use the data-plane REST API rather than the ARM SDK because
 * tag enumeration + manifest delete on a Basic-SKU registry is a registry
 * (`*.azurecr.io`) operation, not an ARM one — Basic SKU has no retention
 * policy, which is exactly why M6 does the GC itself.
 *
 * Auth: `Authorization: Basic base64(user:pass)`. ACR also supports a token
 * exchange, but admin Basic auth is simplest and is what we already have wired.
 */
import { env } from '../../env.js';
import { logger } from '../../lib/logger.js';

const log = logger.child({ component: 'acr-registry' });

export interface AcrTag {
  name: string;
  digest: string;
  lastUpdateTime: string;
}

function registryHost(): string {
  return `${env.ACR_NAME ?? 'prodstack'}.azurecr.io`;
}

/**
 * Percent-encode a repository name for use in a URL path WITHOUT encoding the
 * `/` separators of a nested repo (`user/proj`). `encodeURIComponent` on the
 * whole string would turn the slash into `%2F` and break a nested path; raw
 * interpolation would mishandle any reserved char. Encoding each segment is
 * correct for both. (Repo names are `[a-z0-9-]` single-segment today, so this
 * is a no-op in practice, but it keeps list / get / delete consistent and
 * nested-repo-safe — the prior `deleteManifestByTag` interpolated repo raw
 * while list/get used `encodeURIComponent`, a latent inconsistency.)
 */
function encodeRepoPath(repo: string): string {
  return repo
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

function authHeader(): string {
  const user = env.ACR_USERNAME;
  const pass = env.ACR_PASSWORD;
  if (!user || !pass) {
    throw new Error(
      'ACR_USERNAME / ACR_PASSWORD not configured — cannot reach the registry data-plane API',
    );
  }
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

/** True when ACR admin creds are present so callers can no-op cleanly without them. */
export function hasAcrCredentials(): boolean {
  return Boolean(env.ACR_USERNAME && env.ACR_PASSWORD);
}

async function acrFetch(path: string, init?: RequestInit): Promise<Response> {
  const url = `https://${registryHost()}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: authHeader(), Accept: 'application/json', ...(init?.headers ?? {}) },
  });
  return res;
}

/**
 * Parse the `Link: <...>; rel="next"` header (RFC 5988) ACR uses to page
 * `_catalog` / `_tags`. Returns the next path (the URL inside the angle
 * brackets, which ACR returns as a host-relative path) or null.
 */
function nextLink(res: Response): string | null {
  const link = res.headers.get('link');
  if (!link) return null;
  const match = /<([^>]+)>\s*;\s*rel="?next"?/i.exec(link);
  if (!match) return null;
  const raw = match[1];
  // ACR returns a host-relative path (e.g. `/acr/v1/_catalog?last=...`); keep it
  // relative so acrFetch re-prefixes the host.
  try {
    return raw.startsWith('http') ? new URL(raw).pathname + new URL(raw).search : raw;
  } catch {
    return raw;
  }
}

/**
 * List all repositories in the registry. `GET /acr/v1/_catalog`. Follows the
 * `Link` header for pagination (best-effort; a single page covers this small
 * registry, but the loop is cheap insurance).
 */
export async function listRepositories(): Promise<string[]> {
  const repos: string[] = [];
  let path: string | null = '/acr/v1/_catalog?n=500';
  let pages = 0;
  while (path && pages < 50) {
    const res = await acrFetch(path);
    if (!res.ok) {
      throw new Error(`ACR _catalog failed: ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as { repositories?: string[] };
    if (Array.isArray(body.repositories)) repos.push(...body.repositories);
    path = nextLink(res);
    pages += 1;
  }
  log.debug({ count: repos.length }, 'listed ACR repositories');
  return repos;
}

/**
 * List tags for a repository, newest first. `GET /acr/v1/<repo>/_tags`. Returns
 * `{ name, digest, lastUpdateTime }` per tag — `digest` is the manifest digest
 * the tag points at, which `deleteManifestByTag` deletes.
 */
export async function listTags(repo: string): Promise<AcrTag[]> {
  const tags: AcrTag[] = [];
  let path: string | null = `/acr/v1/${encodeRepoPath(repo)}/_tags?orderby=timedesc&n=500`;
  let pages = 0;
  while (path && pages < 50) {
    const res = await acrFetch(path);
    if (!res.ok) {
      throw new Error(`ACR _tags failed for ${repo}: ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as {
      tags?: Array<{ name?: string; digest?: string; lastUpdateTime?: string }>;
    };
    for (const t of body.tags ?? []) {
      if (typeof t.name === 'string') {
        tags.push({
          name: t.name,
          digest: t.digest ?? '',
          lastUpdateTime: t.lastUpdateTime ?? '',
        });
      }
    }
    path = nextLink(res);
    pages += 1;
  }
  log.debug({ repo, count: tags.length }, 'listed ACR tags');
  return tags;
}

/**
 * Resolve a single tag's manifest digest. Used as a fallback when the caller
 * doesn't already have the digest from `listTags`. `GET /acr/v1/<repo>/_tags/<tag>`.
 */
export async function getTagDigest(repo: string, tag: string): Promise<string> {
  const res = await acrFetch(`/acr/v1/${encodeRepoPath(repo)}/_tags/${encodeURIComponent(tag)}`);
  if (!res.ok) {
    throw new Error(`ACR _tags/${tag} failed for ${repo}: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as { tag?: { digest?: string } };
  const digest = body.tag?.digest;
  if (!digest) {
    throw new Error(`ACR _tags/${tag} for ${repo} returned no digest`);
  }
  return digest;
}

/**
 * Delete the manifest a tag points at. Deleting the manifest removes EVERY tag
 * pointing at it (intended — moving tags like `latest` are protected by the
 * keep-set in cleanupImages). `DELETE /v2/<repo>/manifests/<digest>`.
 *
 * `digest` is optional: pass it when you already have it (from `listTags`) to
 * save a round-trip; otherwise we resolve it via `getTagDigest`.
 */
export async function deleteManifestByTag(
  repo: string,
  tag: string,
  digest?: string,
): Promise<void> {
  const manifestDigest = digest && digest.length > 0 ? digest : await getTagDigest(repo, tag);
  // NOTE: the digest is interpolated RAW, not via encodeURIComponent. A digest
  // is `sha256:<hex>`; the colon is a legal path character (RFC 3986) and ACR's
  // `/v2/<repo>/manifests/<reference>` expects it literal — encoding it to `%3A`
  // makes ACR 404 the reference, which (treated as "already gone" below) would
  // turn every real delete into a silent no-op. The repo path IS encoded (per
  // segment, slashes preserved) to match list/get and stay nested-repo-safe.
  const res = await acrFetch(`/v2/${encodeRepoPath(repo)}/manifests/${manifestDigest}`, {
    method: 'DELETE',
  });
  // 202 Accepted is the documented success; 200 also seen. 404 means it's
  // already gone (e.g. another tag pointing at the same manifest was deleted
  // first in the same run) — treat as success so we never throw on a no-op.
  if (!res.ok && res.status !== 404) {
    throw new Error(
      `ACR manifest delete failed for ${repo}@${manifestDigest}: ${res.status} ${res.statusText}`,
    );
  }
  log.debug({ repo, tag, digest: manifestDigest, status: res.status }, 'deleted ACR manifest');
}
