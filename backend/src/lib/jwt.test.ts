// Set env before importing `env.ts` (validates `process.env` at module load and
// `process.exit(1)`s on failure). ESM hoists imports above top-level statements,
// so these must run first — they do, because there are no imports above them.
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

import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';

import { JwtError, signSession, verifySession } from './jwt.js';

// The security-critical session primitive. These tests lock in every property a
// reviewer relies on: HS256-only, signature + exp enforced, and the iss/aud
// binding that stops a foreign HS256 token (signed with the same secret) from
// ever being accepted as a session.

const JWT_SECRET = process.env.JWT_SECRET!;
const ISSUER = 'prodstack';
const AUDIENCE = 'prodstack-session';

/** base64url-encode a JSON object (for hand-crafting malicious tokens). */
function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

describe('signSession / verifySession', () => {
  it('round-trips a session: verify(sign(id)) returns { sub: id }', () => {
    const token = signSession('user_abc');
    expect(verifySession(token)).toEqual({ sub: 'user_abc' });
  });

  it('binds the token to the fixed issuer + audience', () => {
    const decoded = jwt.decode(signSession('user_abc')) as jwt.JwtPayload;
    expect(decoded.iss).toBe(ISSUER);
    expect(decoded.aud).toBe(AUDIENCE);
    expect(decoded.sub).toBe('user_abc');
    // An expiry is always set (bearer-token window is bounded).
    expect(typeof decoded.exp).toBe('number');
  });

  it('rejects a token signed with a DIFFERENT secret (forged signature)', () => {
    const forged = jwt.sign({ sub: 'user_abc' }, 'a-totally-different-secret-32-chars-long', {
      algorithm: 'HS256',
      issuer: ISSUER,
      audience: AUDIENCE,
      expiresIn: '7d',
    });
    expect(() => verifySession(forged)).toThrow(JwtError);
  });

  it('rejects a token with a tampered signature', () => {
    const token = signSession('user_abc');
    // Flip the last character of the signature segment.
    const tampered = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
    expect(() => verifySession(tampered)).toThrow(JwtError);
  });

  it('rejects an expired token', () => {
    const expired = jwt.sign({ sub: 'user_abc' }, JWT_SECRET, {
      algorithm: 'HS256',
      issuer: ISSUER,
      audience: AUDIENCE,
      expiresIn: -10, // already expired
    });
    expect(() => verifySession(expired)).toThrow(JwtError);
  });

  it('rejects an `alg: none` (unsigned) token', () => {
    const none = `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({
      sub: 'user_abc',
      iss: ISSUER,
      aud: AUDIENCE,
    })}.`;
    expect(() => verifySession(none)).toThrow(JwtError);
  });

  it('rejects a token signed with a non-HS256 algorithm (algorithm confinement)', () => {
    // Correct secret + iss/aud, but HS512 — the verifier allow-lists only HS256.
    const hs512 = jwt.sign({ sub: 'user_abc' }, JWT_SECRET, {
      algorithm: 'HS512',
      issuer: ISSUER,
      audience: AUDIENCE,
      expiresIn: '7d',
    });
    expect(() => verifySession(hs512)).toThrow(JwtError);
  });

  it('rejects a token with the WRONG audience', () => {
    const wrongAud = jwt.sign({ sub: 'user_abc' }, JWT_SECRET, {
      algorithm: 'HS256',
      issuer: ISSUER,
      audience: 'some-other-audience',
      expiresIn: '7d',
    });
    expect(() => verifySession(wrongAud)).toThrow(JwtError);
  });

  it('rejects a token with the WRONG issuer', () => {
    const wrongIss = jwt.sign({ sub: 'user_abc' }, JWT_SECRET, {
      algorithm: 'HS256',
      issuer: 'some-other-issuer',
      audience: AUDIENCE,
      expiresIn: '7d',
    });
    expect(() => verifySession(wrongIss)).toThrow(JwtError);
  });

  it('rejects a legacy token with NO iss/aud (the secret-reuse footgun)', () => {
    // A different feature signing an HS256 JWT with the same JWT_SECRET but no
    // iss/aud must NOT be cross-accepted as a session.
    const legacy = jwt.sign({ sub: 'user_abc' }, JWT_SECRET, {
      algorithm: 'HS256',
      expiresIn: '7d',
    });
    expect(() => verifySession(legacy)).toThrow(JwtError);
  });

  it('rejects a token missing the sub claim', () => {
    const noSub = jwt.sign({ foo: 'bar' }, JWT_SECRET, {
      algorithm: 'HS256',
      issuer: ISSUER,
      audience: AUDIENCE,
      expiresIn: '7d',
    });
    expect(() => verifySession(noSub)).toThrow(JwtError);
  });

  it('rejects a garbage / non-JWT string', () => {
    expect(() => verifySession('not.a.jwt')).toThrow(JwtError);
    expect(() => verifySession('')).toThrow(JwtError);
  });
});
