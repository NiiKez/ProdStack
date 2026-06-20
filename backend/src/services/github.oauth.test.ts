// Unit coverage for the OAuth service functions that HANDLE THE RAW TOKEN —
// exchangeCodeForToken + fetchGithubProfile. The github.test.ts suite covers the
// repo-picker/detect ROUTES (Octokit-based) but never these two `fetch`-based
// functions. Focus: happy paths, the email fallback, and a security regression
// guard that a failed GitHub call never embeds the access token in the thrown
// error (errors must carry only the HTTP status).
process.env.NODE_ENV = 'test';
process.env.WEB_ORIGIN = 'http://localhost:5173';
process.env.PUBLIC_API_URL = 'http://localhost:3000';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.JWT_SECRET = 'test-jwt-secret-test-jwt-secret-test-jwt-secret';
process.env.COOKIE_SECRET = 'test-cookie-secret-test-cookie-secret-test-cookie';
process.env.DATA_ENC_KEY = Buffer.alloc(32, 9).toString('base64');
process.env.GITHUB_OAUTH_CLIENT_ID = 'test-client-id';
process.env.GITHUB_OAUTH_CLIENT_SECRET = 'super-secret-client-secret';
process.env.GITHUB_OAUTH_CALLBACK_URL = 'http://localhost:3000/api/auth/github/callback';
process.env.AZURE_STUB = 'true';
process.env.LOG_LEVEL = 'silent';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GithubAuthError, exchangeCodeForToken, fetchGithubProfile } from './github.js';

/** Build a minimal fetch Response stand-in. */
function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }) {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: async () => body,
  } as unknown as Response;
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('exchangeCodeForToken', () => {
  it('returns the access token on success', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: 'gho_abc123', token_type: 'bearer' }));
    const { accessToken } = await exchangeCodeForToken('the-code');
    expect(accessToken).toBe('gho_abc123');
  });

  it('throws GithubAuthError when GitHub returns an error payload — without leaking the client secret', async () => {
    // Persistent mock (not `Once`) — the single call below consumes it, but this
    // keeps the test robust if it ever calls more than once.
    fetchMock.mockResolvedValue(
      jsonResponse({ error: 'bad_verification_code', error_description: 'The code is incorrect.' }),
    );
    try {
      await exchangeCodeForToken('bad');
      throw new Error('expected exchangeCodeForToken to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(GithubAuthError);
      // Surfaces GitHub's description...
      expect((err as Error).message).toMatch(/incorrect/i);
      // ...but never our client_secret.
      expect((err as Error).message).not.toContain('super-secret-client-secret');
    }
  });

  it('throws GithubAuthError on a non-OK HTTP response (status only, no token)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(null, { ok: false, status: 503 }));
    await expect(exchangeCodeForToken('x')).rejects.toThrow(/HTTP 503/);
  });
});

describe('fetchGithubProfile', () => {
  it('returns the profile, using the email from /user when present', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ id: 42, login: 'octocat', email: 'octo@example.com', avatar_url: 'https://a/x.png' }),
    );
    const profile = await fetchGithubProfile('gho_secret_token');
    expect(profile).toEqual({
      id: 42,
      login: 'octocat',
      email: 'octo@example.com',
      avatarUrl: 'https://a/x.png',
    });
  });

  it('falls back to the primary verified address from /user/emails when /user email is null', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: 7, login: 'priv', email: null, avatar_url: null }))
      .mockResolvedValueOnce(
        jsonResponse([
          { email: 'secondary@example.com', primary: false, verified: true },
          { email: 'primary@example.com', primary: true, verified: true },
        ]),
      );
    const profile = await fetchGithubProfile('gho_secret_token');
    expect(profile.email).toBe('primary@example.com');
  });

  it('SECURITY: a failed /user call throws with the HTTP status only — never the access token', async () => {
    const token = 'gho_DO_NOT_LEAK_me';
    fetchMock.mockResolvedValueOnce(jsonResponse(null, { ok: false, status: 401 }));
    try {
      await fetchGithubProfile(token);
      throw new Error('expected fetchGithubProfile to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(GithubAuthError);
      expect((err as Error).message).toMatch(/HTTP 401/);
      // The bearer token must never appear in an error that could reach a log.
      expect((err as Error).message).not.toContain(token);
    }
  });
});
