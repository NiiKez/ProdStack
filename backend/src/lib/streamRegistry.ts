import { env } from '../env.js';

/**
 * In-memory per-key concurrency counter for long-lived SSE connections.
 *
 * Used to cap how many simultaneous build-log streams ONE user may hold open
 * (`GET /api/builds/:id/logs/stream`). Each open stream keeps a connection alive
 * and polls Postgres on an interval, so an unbounded fan-out is an event-loop /
 * DB-pool exhaustion vector — a hostile demo session could otherwise open
 * thousands. `tryAcquire` reserves a slot (rejecting at the cap), `release`
 * frees it on disconnect.
 *
 * In-memory is correct ONLY because every platform app runs `maxReplicas=1` (the
 * same assumption the in-memory rate limiters rely on — see
 * middleware/rateLimit.ts). If replicas ever rise, each would keep its own
 * counter (effective cap ×N); move to a shared store at that point.
 */
export class StreamConcurrencyRegistry {
  private readonly counts = new Map<string, number>();

  constructor(private readonly max: number) {}

  /** Reserve a slot for `key`. Returns false (reserving nothing) if at the cap. */
  tryAcquire(key: string): boolean {
    const current = this.counts.get(key) ?? 0;
    if (current >= this.max) return false;
    this.counts.set(key, current + 1);
    return true;
  }

  /** Release one previously-acquired slot. Safe to over-call (floors at zero). */
  release(key: string): void {
    const current = this.counts.get(key) ?? 0;
    if (current <= 1) this.counts.delete(key);
    else this.counts.set(key, current - 1);
  }

  /** Current open count for `key` (0 when none). */
  active(key: string): number {
    return this.counts.get(key) ?? 0;
  }
}

/**
 * Process-wide singleton for the build-log SSE endpoint, sized by
 * `MAX_LOG_STREAMS_PER_USER`. Keyed by user id.
 */
export const logStreamRegistry = new StreamConcurrencyRegistry(env.MAX_LOG_STREAMS_PER_USER);
