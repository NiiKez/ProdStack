// C1: the per-IP rate-limit key must be robust against X-Forwarded-For spoofing
// on the directly-reachable API FQDN (which is only 1 proxy hop, not the 3 the
// custom-domain path has). `ipRateLimitKey` trusts the resolved client IP ONLY
// when the request carries the nginx-injected `X-ProdStack-Edge` secret; every
// other request is keyed on the un-spoofable Envoy-appended (right-most) XFF
// entry. We set EDGE_PROXY_SECRET via `vi.hoisted` so it's present before env.ts
// validates, then dynamically import the module under test.
import { ipKeyGenerator } from 'express-rate-limit';
import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';

const EDGE_SECRET = 'edge-secret-abcdefghijklmnop'; // ≥16 chars

vi.hoisted(() => {
  process.env.EDGE_PROXY_SECRET = 'edge-secret-abcdefghijklmnop';
});

const { ipRateLimitKey, userOrIpKey } = await import('./rateLimit.js');

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

describe('ipRateLimitKey (edge-authenticated, EDGE_PROXY_SECRET set)', () => {
  it('trusts req.ip when the request carries the valid edge secret', () => {
    // Came through our nginx → the full XFF chain is trustworthy, so the
    // trust-proxy-resolved req.ip (the real browser IP) is the bucket key.
    const key = ipRateLimitKey(
      fakeReq({ edgeHeader: EDGE_SECRET, ip: '203.0.113.9', xff: '203.0.113.9, 10.0.0.1, 10.0.0.2' }),
    );
    expect(key).toBe(ipKeyGenerator('203.0.113.9'));
  });

  it('IGNORES a forged X-Forwarded-For on a direct hit — keys on the Envoy-appended (last) entry', () => {
    // No edge secret → direct hit on the API FQDN. The attacker prepended fakes;
    // Azure's Envoy appended the real peer LAST. We key on that, not req.ip.
    const key = ipRateLimitKey(
      fakeReq({ ip: '6.6.6.6', xff: '1.1.1.1, 2.2.2.2, 198.51.100.5' }),
    );
    expect(key).toBe(ipKeyGenerator('198.51.100.5'));
  });

  it('cannot mint fresh buckets by rotating the forged prefix (the bypass is closed)', () => {
    // Two direct requests from the SAME real peer but DIFFERENT forged prefixes
    // must map to the SAME key — otherwise an attacker spins up unlimited buckets.
    const k1 = ipRateLimitKey(fakeReq({ xff: 'aa.aa.aa.aa, 198.51.100.5' }));
    const k2 = ipRateLimitKey(fakeReq({ xff: 'bb.bb.bb.bb, cc.cc.cc.cc, dd.dd.dd.dd, 198.51.100.5' }));
    expect(k1).toBe(k2);
    expect(k1).toBe(ipKeyGenerator('198.51.100.5'));
  });

  it('treats a WRONG edge secret as a direct hit (keys on the Envoy peer)', () => {
    // 'not-the-secret' is SHORTER than EDGE_SECRET, so this trips the length
    // pre-check and short-circuits BEFORE timingSafeEqual ever runs.
    const key = ipRateLimitKey(
      fakeReq({ edgeHeader: 'not-the-secret', ip: '6.6.6.6', xff: 'x.x.x.x, 198.51.100.9' }),
    );
    expect(key).toBe(ipKeyGenerator('198.51.100.9'));
  });

  it('treats a SAME-LENGTH wrong edge secret as a direct hit (exercises the timingSafeEqual-false branch)', () => {
    // Built from EDGE_SECRET so it can never drift in length: same byte length,
    // different bytes → passes the length pre-check and forces the constant-time
    // compare to actually run and return false. Must be keyed on the Envoy peer.
    const sameLengthWrong = EDGE_SECRET.toUpperCase();
    expect(Buffer.byteLength(sameLengthWrong)).toBe(Buffer.byteLength(EDGE_SECRET));
    expect(sameLengthWrong).not.toBe(EDGE_SECRET);
    const key = ipRateLimitKey(
      fakeReq({ edgeHeader: sameLengthWrong, ip: '6.6.6.6', xff: 'x.x.x.x, 198.51.100.9' }),
    );
    expect(key).toBe(ipKeyGenerator('198.51.100.9'));
  });

  it('treats an EMPTY-STRING x-prodstack-edge header as absent (keys on the Envoy peer)', () => {
    // An empty header is not a valid secret → direct-hit handling kicks in.
    const key = ipRateLimitKey(
      fakeReq({ edgeHeader: '', ip: '6.6.6.6', xff: 'x.x.x.x, 198.51.100.9' }),
    );
    expect(key).toBe(ipKeyGenerator('198.51.100.9'));
  });

  it('falls back to the socket address on a direct hit with no X-Forwarded-For', () => {
    const key = ipRateLimitKey(fakeReq({ socket: '198.51.100.7' }));
    expect(key).toBe(ipKeyGenerator('198.51.100.7'));
  });

  it('normalizes IPv6 to a /56 so an attacker can not rotate the host portion', () => {
    const a = ipRateLimitKey(fakeReq({ edgeHeader: EDGE_SECRET, ip: '2001:db8:abcd:1234::1' }));
    const b = ipRateLimitKey(fakeReq({ edgeHeader: EDGE_SECRET, ip: '2001:db8:abcd:1234::dead:beef' }));
    expect(a).toBe(b); // same /56 → same bucket
  });
});

describe('userOrIpKey — anonymous fallback inherits the spoof-resistant IP key', () => {
  it('keys an authenticated user on u:<id>, ignoring any IP/XFF', () => {
    const withUser = { ...fakeReq({ ip: '6.6.6.6', xff: '1.1.1.1, 198.51.100.5' }), user: { id: 'alice' } } as unknown as Request;
    expect(userOrIpKey(withUser)).toBe('u:alice');
  });

  it('for an ANONYMOUS direct hit, keys on the Envoy-appended peer — not a forged XFF prefix', () => {
    // No user + no edge secret → the fallback must run through ipRateLimitKey, so
    // an attacker prepending fakes still buckets on the real (last) peer. This is
    // the path that stops an unauthenticated flood from minting fresh buckets.
    const key = userOrIpKey(fakeReq({ xff: 'aa.aa.aa.aa, bb.bb.bb.bb, 198.51.100.5' }));
    expect(key).toBe(ipKeyGenerator('198.51.100.5'));
  });
});
