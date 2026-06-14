// Set env before importing `env.ts` (validates at module load). NODE_ENV='test'
// (≠ 'development') means cookies default to Secure — the prod-like posture.
process.env.NODE_ENV = 'test';
process.env.WEB_ORIGIN = 'http://localhost:5173';
process.env.PUBLIC_API_URL = 'http://localhost:3000';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.JWT_SECRET = 'test-jwt-secret-test-jwt-secret-test-jwt-secret';
process.env.COOKIE_SECRET = 'test-cookie-secret-test-cookie-secret-test-cookie';
process.env.DATA_ENC_KEY = Buffer.alloc(32, 9).toString('base64');
process.env.GITHUB_OAUTH_CLIENT_ID = 'test-client-id';
process.env.GITHUB_OAUTH_CLIENT_SECRET = 'test-client-secret';
process.env.GITHUB_OAUTH_CALLBACK_URL = 'http://localhost:3000/api/auth/github/callback';
process.env.AZURE_STUB = 'true';

import cookieParser from 'cookie-parser';
import express, { type Response } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import {
  clearOAuthCookies,
  clearSessionCookie,
  setOAuthNextCookie,
  setOAuthStateCookie,
  setSessionCookie,
} from './cookies.js';

// Locks in the security flags on every auth cookie. A regression here (a dropped
// HttpOnly/Secure, a widened SameSite, a missing signature) is a real XSS/CSRF
// exposure, so we assert the raw Set-Cookie header rather than trusting the opts.

const COOKIE_SECRET = process.env.COOKIE_SECRET!;

function appWith(handler: (res: Response) => void) {
  const app = express();
  app.use(cookieParser(COOKIE_SECRET));
  app.get('/t', (_req, res) => {
    handler(res);
    res.status(204).end();
  });
  return app;
}

function setCookies(res: { headers: Record<string, unknown> }): string[] {
  const h = res.headers['set-cookie'];
  if (Array.isArray(h)) return h as string[];
  return h ? [String(h)] : [];
}

describe('setSessionCookie', () => {
  it('sets a signed, HttpOnly, Secure, SameSite=Lax, 7-day, path-/ cookie', async () => {
    const res = await request(appWith((r) => setSessionCookie(r, 'the.jwt.token'))).get('/t');
    const cookie = setCookies(res).find((c) => c.startsWith('session='))!;
    expect(cookie).toBeDefined();
    // cookie-parser signs as `s:<value>.<sig>`, URL-encoded to `s%3A...`.
    expect(cookie).toMatch(/^session=s%3A/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(/Max-Age=604800/); // 7 days in seconds
  });
});

describe('clearSessionCookie', () => {
  it('expires the session cookie with matching flags', async () => {
    const res = await request(appWith((r) => clearSessionCookie(r))).get('/t');
    const cookie = setCookies(res).find((c) => c.startsWith('session='))!;
    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Path=\//);
  });
});

describe('OAuth round-trip cookies', () => {
  it('oauth_state is signed, HttpOnly, Secure, SameSite=Lax, 5-min', async () => {
    const res = await request(appWith((r) => setOAuthStateCookie(r, 'state-nonce'))).get('/t');
    const cookie = setCookies(res).find((c) => c.startsWith('oauth_state='))!;
    expect(cookie).toMatch(/^oauth_state=s%3A/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Max-Age=300/); // 5 minutes
  });

  it('oauth_next is signed and short-lived (5-min)', async () => {
    const res = await request(appWith((r) => setOAuthNextCookie(r, '/dashboard'))).get('/t');
    const cookie = setCookies(res).find((c) => c.startsWith('oauth_next='))!;
    expect(cookie).toMatch(/^oauth_next=s%3A/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Max-Age=300/);
  });

  it('clearOAuthCookies expires BOTH oauth_state and oauth_next', async () => {
    const res = await request(appWith((r) => clearOAuthCookies(r))).get('/t');
    const cookies = setCookies(res);
    const state = cookies.find((c) => c.startsWith('oauth_state='))!;
    const next = cookies.find((c) => c.startsWith('oauth_next='))!;
    expect(state).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect(next).toMatch(/Expires=Thu, 01 Jan 1970/);
  });
});
