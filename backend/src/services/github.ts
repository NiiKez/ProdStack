import { Octokit } from '@octokit/rest';

import { env } from '../env.js';
import type { PackageJsonLike, RepoSignals } from './builds/dockerfileGen.js';

/**
 * GitHub services: OAuth code/token exchange, profile fetch, and a
 * pre-authenticated `Octokit` factory other services (projects, webhooks)
 * import.
 *
 * We talk to GitHub via `fetch` for OAuth (no SDK needed for two endpoints)
 * and through `@octokit/rest` for everything else. The Octokit factory takes
 * an already-decrypted PAT/OAuth token — encryption is the auth layer's job.
 */

const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_API = 'https://api.github.com';

export interface GithubProfile {
  id: number;
  login: string;
  email: string | null;
  avatarUrl: string | null;
}

export class GithubAuthError extends Error {
  override readonly name = 'GithubAuthError';
  constructor(message: string, readonly cause?: unknown) {
    super(message);
  }
}

/** Build an Octokit pre-bound to a user's decrypted OAuth token. */
export function octokitForUser(decryptedToken: string): Octokit {
  return new Octokit({
    auth: decryptedToken,
    userAgent: 'prodstack/0.1',
  });
}

/**
 * Structured error from a webhook create/delete call. `status` is the
 * upstream GitHub HTTP code (or `undefined` for a transport-level failure);
 * `message` is GitHub's `message` field when available. The route layer
 * inspects these to map to the right HttpError.
 */
export class GithubWebhookError extends Error {
  override readonly name = 'GithubWebhookError';
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly githubMessage?: string,
    readonly cause?: unknown,
  ) {
    super(message);
  }
}

function extractStatus(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null && 'status' in err) {
    const s = (err as { status?: unknown }).status;
    if (typeof s === 'number') return s;
  }
  return undefined;
}

function extractGithubMessage(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const resp = (err as { response?: { data?: unknown } }).response;
  const data = resp?.data;
  if (typeof data === 'object' && data !== null && 'message' in data) {
    const m = (data as { message?: unknown }).message;
    if (typeof m === 'string') return m;
  }
  return undefined;
}

/**
 * Register a `push` webhook on `{owner}/{repo}`. Returns the GitHub hook id.
 * On failure, throws `GithubWebhookError` so the route can branch on status.
 */
export async function createRepoWebhook(
  octokit: Octokit,
  opts: { owner: string; repo: string; url: string; secret: string },
): Promise<{ id: number }> {
  try {
    const response = await octokit.request('POST /repos/{owner}/{repo}/hooks', {
      owner: opts.owner,
      repo: opts.repo,
      name: 'web',
      active: true,
      events: ['push'],
      config: {
        url: opts.url,
        content_type: 'json',
        secret: opts.secret,
      },
    });
    const data = response.data as { id: number };
    return { id: data.id };
  } catch (err) {
    throw new GithubWebhookError(
      'failed to create repo webhook',
      extractStatus(err),
      extractGithubMessage(err),
      err,
    );
  }
}

/**
 * A repository as surfaced to the frontend repo picker. A trimmed projection of
 * GitHub's `/user/repos` rows — just what the "create project" flow needs.
 */
export interface GithubRepo {
  /** GitHub `full_name`, e.g. "owner/repo". */
  fullName: string;
  /** GitHub `html_url`, e.g. "https://github.com/owner/repo". */
  url: string;
  /** GitHub `default_branch`, e.g. "main". */
  defaultBranch: string;
  /** GitHub `private`. */
  private: boolean;
}

/**
 * Structured error from a repo listing. Wraps the upstream GitHub failure so
 * the route layer can map an auth failure (401) to a clean 502 GITHUB_UNAVAILABLE
 * rather than 500-crashing on a missing/expired token.
 */
export class GithubReposError extends Error {
  override readonly name = 'GithubReposError';
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly githubMessage?: string,
    readonly cause?: unknown,
  ) {
    super(message);
  }
}

/** Hard cap on repos returned, to bound payload size + listing time. */
const MAX_REPOS = 300;

/**
 * List the authenticated user's repositories for the repo picker: owned +
 * collaborator + org-member, most-recently-pushed first, capped at `MAX_REPOS`.
 * Uses `octokit.paginate` so we walk every page transparently. On any GitHub
 * failure throws `GithubReposError` so the route can branch on status.
 */
export async function listUserRepos(octokit: Octokit): Promise<GithubRepo[]> {
  let rows: Array<{
    full_name: string;
    html_url: string;
    default_branch: string;
    private: boolean;
  }>;
  try {
    rows = await octokit.paginate('GET /user/repos', {
      affiliation: 'owner,collaborator,organization_member',
      sort: 'pushed',
      direction: 'desc',
      per_page: 100,
    });
  } catch (err) {
    throw new GithubReposError(
      'failed to list user repos',
      extractStatus(err),
      extractGithubMessage(err),
      err,
    );
  }

  return rows.slice(0, MAX_REPOS).map((r) => ({
    fullName: r.full_name,
    url: r.html_url,
    defaultBranch: r.default_branch,
    private: r.private,
  }));
}

/**
 * Structured error from a repo-signals lookup (framework-detection preview).
 * Wraps the upstream GitHub failure so the route can degrade to a clean 502
 * instead of 500-crashing on a missing/expired token or an unreadable repo.
 */
export class GithubDetectError extends Error {
  override readonly name = 'GithubDetectError';
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly githubMessage?: string,
    readonly cause?: unknown,
  ) {
    super(message);
  }
}

/** Fetch + UTF-8 decode a single repo file via the Contents API, or undefined. */
async function fetchRepoFile(
  octokit: Octokit,
  opts: { owner: string; repo: string; ref: string; path: string },
): Promise<string | undefined> {
  try {
    const response = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
      owner: opts.owner,
      repo: opts.repo,
      path: opts.path,
      ref: opts.ref,
    });
    const data = response.data as { content?: unknown; encoding?: unknown };
    if (typeof data.content !== 'string') return undefined;
    const encoding = data.encoding === 'base64' ? 'base64' : 'utf8';
    return Buffer.from(data.content, encoding).toString('utf8');
  } catch {
    // A missing/oversized/binary file just means "no signal here" — never fatal.
    return undefined;
  }
}

/**
 * Build the {@link RepoSignals} the pure `detectFramework` needs WITHOUT cloning
 * the repo: one recursive Git-trees call for the file layout, then at most two
 * Contents calls for `package.json` / `requirements.txt`. Mirrors
 * `resolveDockerfile.gatherSignals`, but sourced from the GitHub API so the
 * "New Project" modal can preview the detected framework before the first build.
 * Throws `GithubDetectError` on any GitHub failure so the route can map it to a
 * clean 502.
 */
export async function listRepoSignals(
  octokit: Octokit,
  opts: { owner: string; repo: string; ref: string },
): Promise<RepoSignals> {
  let entries: Array<{ path?: string; type?: string }>;
  try {
    const response = await octokit.request('GET /repos/{owner}/{repo}/git/trees/{tree_sha}', {
      owner: opts.owner,
      repo: opts.repo,
      tree_sha: opts.ref,
      recursive: 'true',
    });
    entries = (response.data as { tree?: Array<{ path?: string; type?: string }> }).tree ?? [];
  } catch (err) {
    throw new GithubDetectError(
      'failed to read repository tree',
      extractStatus(err),
      extractGithubMessage(err),
      err,
    );
  }

  const paths = entries
    .map((e) => e.path)
    .filter((p): p is string => typeof p === 'string');
  const rootEntries = paths.filter((p) => !p.includes('/'));

  const hasManagePy = rootEntries.includes('manage.py');
  let djangoWsgiModule: string | undefined;
  if (hasManagePy) {
    // Match `<pkg>/wsgi.py` one level deep, mirroring findDjangoWsgiModule.
    const wsgi = paths.find((p) => /^[^/]+\/wsgi\.py$/.test(p));
    if (wsgi) djangoWsgiModule = `${wsgi.slice(0, wsgi.indexOf('/'))}.wsgi`;
  }

  let packageJson: PackageJsonLike | undefined;
  if (rootEntries.includes('package.json')) {
    const raw = await fetchRepoFile(octokit, { ...opts, path: 'package.json' });
    if (raw !== undefined) {
      try {
        packageJson = JSON.parse(raw) as PackageJsonLike;
      } catch {
        // Malformed package.json → treat as absent (same as gatherSignals).
      }
    }
  }

  const requirementsTxt = rootEntries.includes('requirements.txt')
    ? await fetchRepoFile(octokit, { ...opts, path: 'requirements.txt' })
    : undefined;

  return {
    rootEntries,
    ...(packageJson !== undefined ? { packageJson } : {}),
    hasPackageLock: rootEntries.includes('package-lock.json'),
    ...(requirementsTxt !== undefined ? { requirementsTxt } : {}),
    hasPyproject: rootEntries.includes('pyproject.toml'),
    hasPipfile: rootEntries.includes('Pipfile'),
    hasManagePy,
    ...(djangoWsgiModule !== undefined ? { djangoWsgiModule } : {}),
  };
}

/**
 * Structured error from a commit lookup. Wraps the upstream GitHub failure so
 * the route layer can fall back to the last stored build's commit instead of
 * propagating a raw octokit error.
 */
export class GithubCommitError extends Error {
  override readonly name = 'GithubCommitError';
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly githubMessage?: string,
    readonly cause?: unknown,
  ) {
    super(message);
  }
}

/**
 * Fetch the head commit of `{owner}/{repo}@{ref}` for a manual rebuild. Returns
 * the resolved sha + commit message + a best-effort author label. On any GitHub
 * failure throws `GithubCommitError` so the caller can fall back to the
 * project's most recent stored build.
 */
export async function fetchBranchHeadCommit(
  octokit: Octokit,
  opts: { owner: string; repo: string; ref: string },
): Promise<{ sha: string; message: string; author: string }> {
  try {
    const response = await octokit.request('GET /repos/{owner}/{repo}/commits/{ref}', {
      owner: opts.owner,
      repo: opts.repo,
      ref: opts.ref,
    });
    const data = response.data as {
      sha: string;
      commit: { message: string; author?: { name?: string; login?: string } | null };
      author?: { login?: string } | null;
    };
    const author =
      data.commit.author?.name ?? data.commit.author?.login ?? data.author?.login ?? 'unknown';
    return { sha: data.sha, message: data.commit.message, author };
  } catch (err) {
    throw new GithubCommitError(
      'failed to fetch branch head commit',
      extractStatus(err),
      extractGithubMessage(err),
      err,
    );
  }
}

/** Delete the hook by id. Throws `GithubWebhookError` (incl. 404) for caller to branch. */
export async function deleteRepoWebhook(
  octokit: Octokit,
  opts: { owner: string; repo: string; hookId: number },
): Promise<void> {
  try {
    await octokit.request('DELETE /repos/{owner}/{repo}/hooks/{hook_id}', {
      owner: opts.owner,
      repo: opts.repo,
      hook_id: opts.hookId,
    });
  } catch (err) {
    throw new GithubWebhookError(
      'failed to delete repo webhook',
      extractStatus(err),
      extractGithubMessage(err),
      err,
    );
  }
}

/**
 * Exchange an OAuth `code` (from the GitHub callback) for an access token.
 * Sends JSON (`Accept: application/json`) so we don't have to parse the
 * default `application/x-www-form-urlencoded` response.
 */
export async function exchangeCodeForToken(code: string): Promise<{ accessToken: string }> {
  let res: Response;
  try {
    res = await fetch(GITHUB_TOKEN_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: env.GITHUB_OAUTH_CLIENT_ID,
        client_secret: env.GITHUB_OAUTH_CLIENT_SECRET,
        code,
        redirect_uri: env.GITHUB_OAUTH_CALLBACK_URL,
      }),
    });
  } catch (err) {
    throw new GithubAuthError('Network error exchanging OAuth code', err);
  }

  if (!res.ok) {
    throw new GithubAuthError(`GitHub token exchange failed: HTTP ${res.status}`);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    throw new GithubAuthError('GitHub token exchange returned non-JSON', err);
  }

  if (typeof body !== 'object' || body === null) {
    throw new GithubAuthError('GitHub token exchange returned unexpected payload');
  }

  const obj = body as Record<string, unknown>;
  if (typeof obj.error === 'string') {
    const description = typeof obj.error_description === 'string' ? obj.error_description : obj.error;
    throw new GithubAuthError(`GitHub token exchange error: ${description}`);
  }

  const accessToken = obj.access_token;
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new GithubAuthError('GitHub token exchange missing access_token');
  }

  return { accessToken };
}

interface GithubUserResponse {
  id: number;
  login: string;
  email: string | null;
  avatar_url: string | null;
}

interface GithubEmailResponse {
  email: string;
  primary: boolean;
  verified: boolean;
}

/**
 * Fetch the authenticated user's profile. If `/user` doesn't expose an email
 * (because the user marked it private), fall back to `/user/emails` and pick
 * the primary verified address. Returns `email: null` if none qualifies.
 */
export async function fetchGithubProfile(token: string): Promise<GithubProfile> {
  const userRes = await ghFetch('/user', token);
  if (!userRes.ok) {
    throw new GithubAuthError(`GitHub /user failed: HTTP ${userRes.status}`);
  }
  const user = (await userRes.json()) as GithubUserResponse;

  let email = user.email;
  if (email === null || email === undefined || email === '') {
    email = await fetchPrimaryVerifiedEmail(token);
  }

  return {
    id: user.id,
    login: user.login,
    email: email ?? null,
    avatarUrl: user.avatar_url ?? null,
  };
}

async function fetchPrimaryVerifiedEmail(token: string): Promise<string | null> {
  const res = await ghFetch('/user/emails', token);
  if (!res.ok) {
    // Email scope might be absent; treat as "no email" rather than failing
    // the whole sign-in. Caller persists `null`.
    return null;
  }
  const emails = (await res.json()) as GithubEmailResponse[];
  if (!Array.isArray(emails)) return null;
  const primary = emails.find((e) => e.primary && e.verified);
  if (primary !== undefined) return primary.email;
  const anyVerified = emails.find((e) => e.verified);
  return anyVerified?.email ?? null;
}

async function ghFetch(path: string, token: string): Promise<Response> {
  try {
    return await fetch(`${GITHUB_API}${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'prodstack/0.1',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
  } catch (err) {
    throw new GithubAuthError(`Network error calling GitHub ${path}`, err);
  }
}
