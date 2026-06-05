process.env.NODE_ENV = 'test';
process.env.DATA_ENC_KEY ??= Buffer.alloc(32, 9).toString('base64');
process.env.JWT_SECRET ??= 'x'.repeat(40);
process.env.COOKIE_SECRET ??= 'y'.repeat(40);
process.env.WEB_ORIGIN ??= 'http://localhost:5173';
process.env.GITHUB_OAUTH_CLIENT_ID ??= 'cid';
process.env.GITHUB_OAUTH_CLIENT_SECRET ??= 'csecret';
process.env.GITHUB_OAUTH_CALLBACK_URL ??= 'http://localhost:3000/api/auth/github/callback';
process.env.DATABASE_URL ??= 'postgresql://test/test';
process.env.AZURE_STUB ??= 'true';
process.env.LOG_LEVEL ??= 'silent';

import express from 'express';
import { describe, expect, it } from 'vitest';

import { makeRateLimiter } from './rateLimit.js';

const supertest = (await import('supertest')).default;

/** Tiny app with a single GET / guarded by the supplied limiter. */
function appWith(limiter: express.RequestHandler): express.Express {
  const app = express();
  // The limiter keys per-IP; supertest requests all originate from the same
  // loopback address, so they share a counter.
  app.use(limiter);
  app.get('/', (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe('makeRateLimiter', () => {
  it('allows requests up to `max` then returns 429 (skip overridden to () => false)', async () => {
    const app = appWith(makeRateLimiter({ windowMs: 60_000, max: 2, skip: () => false }));

    const r1 = await supertest(app).get('/');
    expect(r1.status).toBe(200);

    const r2 = await supertest(app).get('/');
    expect(r2.status).toBe(200);

    const r3 = await supertest(app).get('/');
    expect(r3.status).toBe(429);
    expect(r3.body.error).toBe('RATE_LIMITED');
  });

  it('sets standard RateLimit headers (legacy X-RateLimit-* off)', async () => {
    const app = appWith(makeRateLimiter({ windowMs: 60_000, max: 5, skip: () => false }));
    const res = await supertest(app).get('/');
    expect(res.status).toBe(200);
    // express-rate-limit draft headers (standardHeaders: true).
    expect(res.headers['ratelimit-limit'] ?? res.headers['ratelimit']).toBeDefined();
    expect(res.headers['x-ratelimit-limit']).toBeUndefined();
  });

  it('default skip is active under NODE_ENV=test (max:1 still lets >1 through)', async () => {
    // No `skip` override → the factory default `() => env.NODE_ENV === 'test'`
    // applies, so even with max:1 the limiter never blocks in the test env.
    const app = appWith(makeRateLimiter({ windowMs: 60_000, max: 1 }));

    for (let i = 0; i < 4; i++) {
      const res = await supertest(app).get('/');
      expect(res.status).toBe(200);
    }
  });
});
