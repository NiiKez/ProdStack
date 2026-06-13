// C1 (production-default branch): when EDGE_PROXY_SECRET is unset/empty — the
// CURRENT LIVE PROD DEFAULT, since the edge secret isn't activated yet —
// `arrivedViaTrustedEdge` returns true and `ipRateLimitKey` trusts `req.ip`
// (the trust-proxy-resolved client) rather than the Envoy-appended peer. The
// sibling `rateLimit.edge.test.ts` ALWAYS sets the secret via vi.hoisted, so
// this exact path had zero coverage. We GUARANTEE the var is unset before
// env.ts validates, regardless of which test file ran first (the sibling sets
// it and never cleans up), then dynamically import the module under test.
import { ipKeyGenerator } from 'express-rate-limit';
import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  delete process.env.EDGE_PROXY_SECRET;
});

const { ipRateLimitKey } = await import('./rateLimit.js');

/** Minimal Request stand-in exercising the fields ipRateLimitKey reads. */
function fakeReq(opts: {
  edgeHeader?: string;
  ip?: string;
  xff?: string;
  socket?: string;
}): Request {
  const headers: Record<string, string> = {};
  if (opts.xff !== undefined) headers['x-forwarded-for'] = opts.xff;
  if (opts.edgeHeader !== undefined) headers['x-prodstack-edge'] = opts.edgeHeader;
  return {
    ip: opts.ip,
    headers,
    socket: { remoteAddress: opts.socket },
    get(name: string) {
      return headers[name.toLowerCase()];
    },
  } as unknown as Request;
}

describe('ipRateLimitKey (EDGE_PROXY_SECRET UNSET — live production default)', () => {
  it('trusts req.ip and ignores the Envoy peer when no edge secret is configured', () => {
    // Current production behaviour: EDGE_PROXY_SECRET is not yet activated, so
    // arrivedViaTrustedEdge() falls back to trusting req.ip. The forged XFF
    // prefix is ignored — we key on req.ip (203.0.113.9), NOT the last XFF
    // entry (2.2.2.2). This pins the live default until the secret is wired.
    const key = ipRateLimitKey(fakeReq({ ip: '203.0.113.9', xff: '1.1.1.1, 2.2.2.2' }));
    expect(key).toBe(ipKeyGenerator('203.0.113.9'));
  });

  it('ignores an x-prodstack-edge header entirely when no secret is configured', () => {
    // Even with the edge header present, an unset secret short-circuits to
    // trusting req.ip — the header is never compared against anything.
    const key = ipRateLimitKey(
      fakeReq({ edgeHeader: 'anything-at-all', ip: '203.0.113.9', xff: '1.1.1.1, 2.2.2.2' }),
    );
    expect(key).toBe(ipKeyGenerator('203.0.113.9'));
  });

  it("falls back to ipKeyGenerator('unknown') when req.ip is undefined and no secret is set", () => {
    // No secret → trust req.ip; req.ip undefined → the 'unknown' sentinel.
    const key = ipRateLimitKey(fakeReq({ xff: '1.1.1.1, 2.2.2.2' }));
    expect(key).toBe(ipKeyGenerator('unknown'));
  });
});
