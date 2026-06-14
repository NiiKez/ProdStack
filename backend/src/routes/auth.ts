import { randomBytes, timingSafeEqual } from 'node:crypto';

import { Router, type Request } from 'express';

import { prisma } from '../db.js';
import { env } from '../env.js';
import { OAUTH_NEXT_COOKIE, OAUTH_STATE_COOKIE, clearOAuthCookies, clearSessionCookie, setOAuthNextCookie, setOAuthStateCookie, setSessionCookie } from '../lib/cookies.js';
import { encrypt } from '../lib/crypto.js';
import { signSession } from '../lib/jwt.js';
import { authLimiter } from '../middleware/rateLimit.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireXRequestedWith } from '../middleware/requireXRequestedWith.js';
import { exchangeCodeForToken, fetchGithubProfile } from '../services/github.js';

/**
 * Auth router — mounted by `app.ts` under `/api/auth`. Implements the four
 * endpoints:
 *
 *   GET  /github/begin     start GitHub OAuth dance
 *   GET  /github/callback  finish dance, mint session cookie
 *   GET  /me               echo current user (requires session)
 *   POST /signout          clear session (CSRF-gated, idempotent)
 *
 * Notes:
 *   - State is a 16-byte random hex string in a signed httpOnly cookie.
 *     The signature alone would defeat tampering, but the OAuth spec wants
 *     a per-request nonce echoed back as `?state=`.
 *   - We never read the OAuth token client-side; it lives encrypted in
 *     Postgres and is decrypted only inside services that need it.
 */

const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const OAUTH_SCOPES = 'repo admin:repo_hook';

const router = Router();

router.get('/github/begin', authLimiter, (req, res) => {
  const state = randomBytes(16).toString('hex');
  setOAuthStateCookie(res, state);

  const nextRaw = req.query.next;
  if (typeof nextRaw === 'string' && isSafeNextPath(nextRaw)) {
    setOAuthNextCookie(res, nextRaw);
  }

  const params = new URLSearchParams({
    client_id: env.GITHUB_OAUTH_CLIENT_ID,
    redirect_uri: env.GITHUB_OAUTH_CALLBACK_URL,
    scope: OAUTH_SCOPES,
    state,
    allow_signup: 'true',
  });

  res.redirect(302, `${GITHUB_AUTHORIZE_URL}?${params.toString()}`);
});

router.get('/github/callback', authLimiter, async (req, res, next) => {
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const expectedState = req.signedCookies?.[OAUTH_STATE_COOKIE];
  const nextPath = readNextCookie(req);

  if (
    code.length === 0 ||
    state.length === 0 ||
    typeof expectedState !== 'string' ||
    expectedState.length === 0 ||
    !safeEqualStrings(state, expectedState)
  ) {
    clearOAuthCookies(res);
    res.status(400).json({ error: 'OAUTH_STATE_MISMATCH' });
    return;
  }

  // State is single-use: clear it the moment it validates, BEFORE the (async)
  // token exchange. A captured (code, state, oauth_state-cookie) triple can
  // therefore not be replayed within the 5-minute cookie TTL — a second
  // callback finds no state cookie and is rejected above.
  clearOAuthCookies(res);

  try {
    const { accessToken } = await exchangeCodeForToken(code);
    const profile = await fetchGithubProfile(accessToken);

    // Single-user demo gate. When `OWNER_GITHUB_ID` is configured, only the owner may sign
    // in — anyone else is bounced to the landing page with a notice pointing
    // them at the repo to self-host. We reject *before* the upsert so a
    // non-owner's OAuth token is never persisted: no DB row, no stored token.
    if (env.OWNER_GITHUB_ID !== undefined && profile.id !== env.OWNER_GITHUB_ID) {
      res.redirect(302, `${env.WEB_ORIGIN}/?denied=not_owner`);
      return;
    }

    const enc = encrypt(accessToken);

    const user = await prisma.user.upsert({
      where: { githubUserId: profile.id },
      create: {
        githubUserId: profile.id,
        githubLogin: profile.login,
        email: profile.email,
        avatarUrl: profile.avatarUrl,
        githubTokenCiphertext: enc.ciphertext,
        githubTokenIv: enc.iv,
        githubTokenAuthTag: enc.authTag,
        githubTokenKeyVersion: enc.keyVersion,
      },
      update: {
        githubLogin: profile.login,
        email: profile.email,
        avatarUrl: profile.avatarUrl,
        githubTokenCiphertext: enc.ciphertext,
        githubTokenIv: enc.iv,
        githubTokenAuthTag: enc.authTag,
        githubTokenKeyVersion: enc.keyVersion,
      },
      select: { id: true },
    });

    const jwtToken = signSession(user.id);
    setSessionCookie(res, jwtToken);

    const destination = nextPath ?? '/dashboard';
    res.redirect(302, `${env.WEB_ORIGIN}${destination}`);
  } catch (err) {
    next(err);
  }
});

router.get('/me', requireAuth, (req, res) => {
  // `requireAuth` guarantees `req.user`.
  const user = req.user!;
  res.json({
    id: user.id,
    githubLogin: user.githubLogin,
    email: user.email,
    avatarUrl: user.avatarUrl,
    isDemo: user.isDemo,
  });
});

router.post('/signout', requireXRequestedWith, (_req, res) => {
  clearSessionCookie(res);
  res.status(204).end();
});

function readNextCookie(req: Request): string | null {
  const raw = req.signedCookies?.[OAUTH_NEXT_COOKIE];
  if (typeof raw !== 'string' || !isSafeNextPath(raw)) {
    return null;
  }
  return raw;
}

/**
 * Allow only paths that look like `/safe/path?query#hash`. Rejects:
 *   - protocol-relative `//evil.com/...`
 *   - backslash-as-separator (`/\evil.com`) — browsers normalize to `//`
 *   - whitespace (which some browsers strip before URL parsing)
 *   - anything outside a conservative ASCII path/query/fragment alphabet
 */
const SAFE_NEXT_RE = /^\/[A-Za-z0-9_\-./~%?&=#:]*$/;
function isSafeNextPath(raw: string): boolean {
  if (raw.length === 0 || raw.length > 512) return false;
  if (!raw.startsWith('/')) return false;
  if (raw.startsWith('//') || raw.startsWith('/\\')) return false;
  if (/\s/.test(raw)) return false;
  return SAFE_NEXT_RE.test(raw);
}

function safeEqualStrings(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export default router;
