import { randomBytes, timingSafeEqual } from 'node:crypto';

import { Router, type Request } from 'express';

import { prisma } from '../db.js';
import { env } from '../env.js';
import { OAUTH_NEXT_COOKIE, OAUTH_STATE_COOKIE, clearOAuthCookies, clearOAuthNextCookie, clearSessionCookie, setOAuthNextCookie, setOAuthStateCookie, setSessionCookie } from '../lib/cookies.js';
import { encrypt } from '../lib/crypto.js';
import { signSession } from '../lib/jwt.js';
import { OAUTH_SCOPES } from '../lib/oauthScopes.js';
import { isSafeNextPath } from '../lib/safeNext.js';
import { authLimiter } from '../middleware/rateLimit.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireXRequestedWith } from '../middleware/requireXRequestedWith.js';
import { exchangeCodeForToken, fetchGithubProfile } from '../services/github.js';
import { recordSecurityEvent } from '../services/securityEvents.js';

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

const router = Router();

router.get('/github/begin', authLimiter, (req, res) => {
  const state = randomBytes(16).toString('hex');
  setOAuthStateCookie(res, state);

  const nextRaw = req.query.next;
  if (typeof nextRaw === 'string' && isSafeNextPath(nextRaw)) {
    setOAuthNextCookie(res, nextRaw);
  } else {
    // Drop any `oauth_next` from a prior begin so this login can't inherit a
    // stale redirect target the user didn't ask for this time.
    clearOAuthNextCookie(res);
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
    // Audit the rejected callback — this is the OAuth CSRF/replay guard tripping
    // (tampered, replayed, or expired state). We record only a NON-secret reason
    // CATEGORY, never the `code`/`state` values themselves (the very params
    // safeReqSerializer also keeps out of the access log). No actor is known yet:
    // the GitHub profile isn't fetched until the state validates.
    const reason =
      code.length === 0
        ? 'missing_code'
        : state.length === 0
          ? 'missing_state'
          : typeof expectedState !== 'string' || expectedState.length === 0
            ? 'missing_state_cookie'
            : 'state_mismatch';
    await recordSecurityEvent({
      action: 'auth.oauth_state_mismatch',
      outcome: 'failure',
      ip: req.ip ?? null,
      metadata: { reason },
    });
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
      // Audit the owner-gate denial. The rejected user is NOT the owner, so the
      // actor fields carry the *attempting* GitHub identity (never the owner's),
      // and we never log the OAuth token/code — only the profile id/login + ip.
      await recordSecurityEvent({
        action: 'auth.denied_not_owner',
        outcome: 'denied',
        actorGithubId: profile.id,
        actorLogin: profile.login,
        ip: req.ip ?? null,
      });
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
      // createdAt/updatedAt let us derive whether the row was created vs updated
      // for the audit event below — on a fresh insert both are the same now();
      // an update bumps updatedAt past createdAt.
      select: { id: true, createdAt: true, updatedAt: true },
    });

    // Audit the login + token persistence. Keys-only `created` flag (a new user
    // row vs. a returning one); never log the OAuth token.
    const created =
      user.createdAt instanceof Date &&
      user.updatedAt instanceof Date &&
      user.createdAt.getTime() === user.updatedAt.getTime();
    await recordSecurityEvent({
      action: 'auth.login',
      outcome: 'success',
      userId: user.id,
      actorGithubId: profile.id,
      actorLogin: profile.login,
      ip: req.ip ?? null,
      metadata: { created },
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

function safeEqualStrings(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export default router;
