// Per-user SSE concurrency cap (DoS / DB-pool / event-loop defense). The class
// is env-independent (cap passed to the constructor); the exported singleton is
// sized by MAX_LOG_STREAMS_PER_USER, which we pin via vi.hoisted so it's present
// before env.ts validates.
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.MAX_LOG_STREAMS_PER_USER = '2';
});

const { StreamConcurrencyRegistry, logStreamRegistry } = await import('./streamRegistry.js');

describe('StreamConcurrencyRegistry', () => {
  it('allows up to `max` concurrent slots, rejects beyond, frees on release', () => {
    const r = new StreamConcurrencyRegistry(2);
    expect(r.tryAcquire('u')).toBe(true);
    expect(r.active('u')).toBe(1);
    expect(r.tryAcquire('u')).toBe(true);
    expect(r.active('u')).toBe(2);
    // At cap — rejected, and nothing reserved.
    expect(r.tryAcquire('u')).toBe(false);
    expect(r.active('u')).toBe(2);
    // Free one → a slot opens up again.
    r.release('u');
    expect(r.active('u')).toBe(1);
    expect(r.tryAcquire('u')).toBe(true);
  });

  it('counts each key independently — one user can not exhaust another', () => {
    const r = new StreamConcurrencyRegistry(1);
    expect(r.tryAcquire('alice')).toBe(true);
    expect(r.tryAcquire('alice')).toBe(false); // alice at cap
    expect(r.tryAcquire('bob')).toBe(true); // bob unaffected
    expect(r.active('alice')).toBe(1);
    expect(r.active('bob')).toBe(1);
  });

  it('release floors at zero and forgets idle keys (no leak)', () => {
    const r = new StreamConcurrencyRegistry(3);
    r.release('ghost'); // never acquired — safe no-op
    expect(r.active('ghost')).toBe(0);
    r.tryAcquire('u');
    r.release('u');
    r.release('u'); // over-release — still floors at zero
    expect(r.active('u')).toBe(0);
  });

  it('the singleton enforces MAX_LOG_STREAMS_PER_USER (pinned to 2 here)', () => {
    expect(logStreamRegistry).toBeInstanceOf(StreamConcurrencyRegistry);
    expect(logStreamRegistry.tryAcquire('s')).toBe(true);
    expect(logStreamRegistry.tryAcquire('s')).toBe(true);
    expect(logStreamRegistry.tryAcquire('s')).toBe(false); // cap = 2
    logStreamRegistry.release('s');
    logStreamRegistry.release('s');
    expect(logStreamRegistry.active('s')).toBe(0);
  });
});
