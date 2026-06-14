import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

import { prisma } from '../db.js';
import { HttpError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { logStreamRegistry } from '../lib/streamRegistry.js';
import { streamLimiter } from '../middleware/rateLimit.js';
import { requireXRequestedWith } from '../middleware/requireXRequestedWith.js';

/**
 * Builds router — mounted under `/api/builds` (behind requireAuth). The
 * build read paths:
 *
 *   GET /:id              build detail (ownership-checked)
 *   GET /:id/logs         paginated log lines for non-live viewing
 *   GET /:id/logs/stream  SSE: replay-from-cursor → live tail → done
 *
 * ## Why the SSE endpoint tails Postgres instead of an in-process EventEmitter
 *
 * The original design assumed a single API replica that both runs the build
 * and serves the stream, so an in-process pub/sub would do. That assumption is
 * gone: the build runs in the dedicated `prodstack-builder` Container App
 * (a *different* process from the API in prod). The only thing both
 * processes share is Postgres, so Postgres IS the bus. The handler polls
 * `LogLine` by `seq` and `Build.status`, which is correct in both topologies
 * (dev: worker in-process; prod: worker in its own container) with no extra
 * moving parts. Latency is the poll interval (~1s) — fine for build logs.
 */

const router = Router();

const idParam = z.object({ id: z.string().min(1).max(40) });

const logsQuery = z.object({
  afterSeq: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});

/** Statuses past which no further logs or transitions will ever arrive. */
const TERMINAL_BUILD_STATUSES = ['READY', 'FAILED', 'CANCELLED'] as const;
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(TERMINAL_BUILD_STATUSES);

const STREAM_POLL_MS = 1000;
const STREAM_HEARTBEAT_MS = 15_000;
const STREAM_BATCH = 1000;

function getUserId(req: Request): string {
  const id = req.user?.id;
  if (typeof id !== 'string') {
    throw new HttpError(401, 'UNAUTHENTICATED');
  }
  return id;
}

const ownedBuildArgs = {
  include: {
    project: {
      select: {
        id: true,
        name: true,
        githubRepoFullName: true,
        containerAppName: true,
        liveUrl: true,
      },
    },
  },
} as const;

/**
 * Fetch a build only if it belongs to a live project owned by `userId`.
 * Returns null for both "doesn't exist" and "not yours" so the API never
 * leaks the existence of another user's build.
 */
async function findOwnedBuild(buildId: string, userId: string) {
  return prisma.build.findFirst({
    where: { id: buildId, project: { userId, deletedAt: null } },
    ...ownedBuildArgs,
  });
}

type OwnedBuild = NonNullable<Awaited<ReturnType<typeof findOwnedBuild>>>;

function serializeBuild(build: OwnedBuild) {
  return {
    id: build.id,
    status: build.status,
    commitSha: build.commitSha,
    commitMessage: build.commitMessage,
    commitAuthor: build.commitAuthor,
    branch: build.branch,
    imageTag: build.imageTag,
    startedAt: build.startedAt,
    finishedAt: build.finishedAt,
    durationMs: build.durationMs,
    errorMessage: build.errorMessage,
    createdAt: build.createdAt,
    project: {
      id: build.project.id,
      name: build.project.name,
      githubRepoFullName: build.project.githubRepoFullName,
      liveUrl: build.project.liveUrl,
    },
  };
}

interface LogRow {
  seq: number;
  level: string;
  message: string;
  ts: Date;
}

function serializeLine(line: LogRow) {
  return { seq: line.seq, level: line.level, message: line.message, ts: line.ts };
}

// --- GET /api/builds/:id ---------------------------------------------------

router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = idParam.parse(req.params);
    const userId = getUserId(req);
    const build = await findOwnedBuild(id, userId);
    if (build === null) {
      throw new HttpError(404, 'BUILD_NOT_FOUND');
    }
    res.json(serializeBuild(build));
  } catch (err) {
    next(err);
  }
});

// --- GET /api/builds/:id/logs (paginated, non-live) ------------------------

router.get('/:id/logs', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = idParam.parse(req.params);
    const userId = getUserId(req);
    const { afterSeq, limit } = logsQuery.parse(req.query);

    const build = await findOwnedBuild(id, userId);
    if (build === null) {
      throw new HttpError(404, 'BUILD_NOT_FOUND');
    }

    const lines = await prisma.logLine.findMany({
      where: { buildId: id, seq: { gt: afterSeq } },
      orderBy: { seq: 'asc' },
      take: limit,
      select: { seq: true, level: true, message: true, ts: true },
    });

    res.json({
      status: build.status,
      lines: lines.map(serializeLine),
      nextSeq: lines.length > 0 ? lines[lines.length - 1]!.seq : afterSeq,
    });
  } catch (err) {
    next(err);
  }
});

// --- POST /api/builds/:id/cancel -------------------------------------------

/**
 * Cancel a build. Two paths, depending on whether a worker has claimed it:
 *
 *  - Fast path (unclaimed QUEUED): flip it straight to CANCELLED with a
 *    conditional `updateMany` (`status='QUEUED' AND claimedAt IS NULL`). If
 *    that wins the race the worker's claim query — which also filters on
 *    `status='QUEUED' AND claimedAt IS NULL` — will simply never pick it up.
 *  - Cooperative path (claimed / in-flight): we can't stop the worker from the
 *    API, so set `cancelRequested=true`. The worker's `runBuild` polls this
 *    flag, aborts its child process, and transitions the build to CANCELLED.
 *    Responds 202 (accepted, not yet terminal).
 */
router.post('/:id/cancel', requireXRequestedWith, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = idParam.parse(req.params);
    const userId = getUserId(req);

    const build = await findOwnedBuild(id, userId);
    if (build === null) {
      throw new HttpError(404, 'BUILD_NOT_FOUND');
    }

    if (TERMINAL_STATUSES.has(build.status)) {
      throw new HttpError(409, 'BUILD_NOT_CANCELLABLE', 'This build has already finished.');
    }

    // Fast path: cancel before any worker claims it. The claim query filters
    // on the same `status='QUEUED' AND claimedAt IS NULL`, so this is an
    // atomic race we either win (count===1) or lose (count===0 → cooperative).
    const fast = await prisma.build.updateMany({
      where: { id, status: 'QUEUED', claimedAt: null },
      data: { status: 'CANCELLED', finishedAt: new Date(), errorMessage: 'cancelled by user' },
    });
    if (fast.count === 1) {
      logger.info({ buildId: id, userId, path: 'fast' }, 'build cancelled (unclaimed)');
      res.json({ id, status: 'CANCELLED', cancelRequested: false });
      return;
    }

    // Cooperative path: the worker owns it; ask it to abort. Scope the write to
    // a still-cancellable status — the build may have reached a terminal state
    // (or been deleted by a project cascade) in the window between the read
    // above and here. A plain `update` would either flip the flag on an
    // already-finished build (misleading 202) or throw P2025 → 500 on a deleted
    // row. `count===0` means there's nothing left to cancel.
    const coop = await prisma.build.updateMany({
      where: { id, status: { notIn: [...TERMINAL_BUILD_STATUSES] } },
      data: { cancelRequested: true },
    });
    if (coop.count === 0) {
      throw new HttpError(409, 'BUILD_NOT_CANCELLABLE', 'This build has already finished.');
    }
    logger.info({ buildId: id, userId, path: 'cooperative', status: build.status }, 'build cancellation requested');
    res.status(202).json({ id, status: build.status, cancelRequested: true });
  } catch (err) {
    next(err);
  }
});

// --- GET /api/builds/:id/logs/stream (SSE) ---------------------------------

router.get('/:id/logs/stream', streamLimiter, async (req: Request, res: Response) => {
  const parsedParams = idParam.safeParse(req.params);
  if (!parsedParams.success) {
    res.status(400).json({ error: 'VALIDATION_FAILED' });
    return;
  }
  const buildId = parsedParams.data.id;

  let userId: string;
  try {
    userId = getUserId(req);
  } catch {
    res.status(401).json({ error: 'UNAUTHORIZED' });
    return;
  }

  // Guard the only `await` that runs BEFORE `res.writeHead`. This handler is
  // async but takes no `next`, and Express 4 does not route an async-handler
  // rejection to the error middleware — so a transient DB error here (the shared
  // Postgres is reachably flaky) would surface as an unhandledRejection and leave
  // the client socket hanging open until it times out, instead of a clean 500.
  // No slot/timer is held yet, so a plain 500 is the complete cleanup.
  let build: Awaited<ReturnType<typeof findOwnedBuild>>;
  try {
    build = await findOwnedBuild(buildId, userId);
  } catch (err) {
    logger.warn({ err, buildId }, 'sse stream setup failed');
    res.status(500).json({ error: 'INTERNAL' });
    return;
  }
  if (build === null) {
    res.status(404).json({ error: 'BUILD_NOT_FOUND' });
    return;
  }

  // Concurrency cap (DoS / DB-pool / event-loop defense): bound how many
  // simultaneous log streams ONE user may hold open — each keeps a connection
  // alive and polls Postgres on an interval. `streamLimiter` caps the OPEN RATE;
  // this caps the CONCURRENT COUNT (a hostile demo session could otherwise open
  // thousands). The slot is released in cleanup() when the connection closes.
  if (!logStreamRegistry.tryAcquire(userId)) {
    res.setHeader('Retry-After', '5');
    res.status(429).json({
      error: 'TOO_MANY_STREAMS',
      message: 'Too many open log streams. Close one and retry.',
    });
    return;
  }

  // Release the slot exactly once, however the connection ends — normal `done`,
  // client disconnect, OR a throw during the synchronous setup below (writeHead
  // on an already-destroyed socket) BEFORE `cleanup`/the close handler are wired.
  // `res` emits 'close' on every termination (incl. an aborted socket), so this
  // guarantees the reserved slot can never leak a permanent decrement on an error
  // path (which would otherwise shrink the user's cap until a process restart).
  // Idempotent + independent of the timers, so it's safe even if it fires before
  // they're declared (where `cleanup` would hit a TDZ on pollTimer).
  let slotReleased = false;
  const releaseSlot = (): void => {
    if (slotReleased) return;
    slotReleased = true;
    logStreamRegistry.release(userId);
  };
  res.on('close', releaseSlot);

  // Cursor precedence: `Last-Event-ID` (set automatically by the browser's
  // EventSource on reconnect) overrides the initial `?afterSeq=`. Both are
  // the last `seq` the client already has, so we stream strictly greater.
  let cursor = 0;
  const afterSeqRaw = req.query.afterSeq;
  if (typeof afterSeqRaw === 'string' && /^\d+$/.test(afterSeqRaw)) {
    cursor = Number(afterSeqRaw);
  }
  const lastEventId = req.headers['last-event-id'];
  if (typeof lastEventId === 'string' && /^\d+$/.test(lastEventId)) {
    cursor = Number(lastEventId);
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Disable proxy buffering (nginx/Envoy) so events flush immediately.
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  let closed = false;
  let lastStatus: string | null = null;
  let terminalSeen = false;

  const write = (chunk: string): void => {
    if (!closed) res.write(chunk);
  };

  const send = (event: string, data: unknown, eventId?: number): void => {
    if (eventId !== undefined) write(`id: ${eventId}\n`);
    write(`event: ${event}\n`);
    write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(pollTimer);
    clearInterval(heartbeatTimer);
    releaseSlot();
    res.end();
  };

  /** Drain all log rows past the cursor in batches; returns how many were sent. */
  const drainLogs = async (): Promise<number> => {
    let sent = 0;
    for (;;) {
      const lines = await prisma.logLine.findMany({
        where: { buildId, seq: { gt: cursor } },
        orderBy: { seq: 'asc' },
        take: STREAM_BATCH,
        select: { seq: true, level: true, message: true, ts: true },
      });
      if (lines.length === 0) break;
      for (const line of lines) {
        send('log', serializeLine(line), line.seq);
        cursor = line.seq;
        sent += 1;
      }
      if (lines.length < STREAM_BATCH) break;
    }
    return sent;
  };

  // Reentrancy guard: `poll` is async and a slow drain (large build / DB latency
  // on the shared Postgres) can outlast STREAM_POLL_MS. Without this, the interval
  // would fire a second `poll` while the first is still in flight; the two share
  // the closure's `cursor`/`lastStatus`/`terminalSeen`, so overlapping runs would
  // double-send log rows (both read the same cursor before either advances it) and
  // race the terminal-state machine. The flag makes any tick that overlaps an
  // in-flight poll a no-op.
  let polling = false;
  const poll = async (): Promise<void> => {
    if (closed || polling) return;
    polling = true;
    try {
      // `lastStatus === null` only on the very first poll (the prime call).
      const isFirstPoll = lastStatus === null;
      const sent = await drainLogs();

      const current = await prisma.build.findUnique({
        where: { id: buildId },
        select: { status: true, durationMs: true, errorMessage: true },
      });
      if (current === null) {
        cleanup();
        return;
      }

      if (current.status !== lastStatus) {
        lastStatus = current.status;
        send('status', { status: current.status });
      }

      const finishStream = (status: string, durationMs: number | null, errorMessage: string | null): void => {
        send('done', { status, durationMs, errorMessage });
        cleanup();
      };

      if (TERMINAL_STATUSES.has(current.status)) {
        if (isFirstPoll) {
          // Build was already terminal when the client connected, so the
          // runner has returned and flushed every line. One more drain
          // covers the SUCCESS/ERROR line written microseconds after the
          // status flip, then we finish immediately — no need to make the
          // client wait a poll interval for logs of an already-done build.
          await drainLogs();
          finishStream(current.status, current.durationMs, current.errorMessage);
          return;
        }
        // Mid-stream terminal: the runner sets the terminal status *before*
        // its trailing fire-and-forget log writes finish flushing, so wait
        // for one subsequent poll that drains zero new rows before `done` —
        // that guarantees the stragglers reach the client first.
        if (terminalSeen && sent === 0) {
          finishStream(current.status, current.durationMs, current.errorMessage);
          return;
        }
        terminalSeen = true;
      }
    } catch (err) {
      logger.warn({ err, buildId }, 'sse poll failed');
    } finally {
      polling = false;
    }
  };

  const pollTimer = setInterval(() => void poll(), STREAM_POLL_MS);
  const heartbeatTimer = setInterval(() => write(':hb\n\n'), STREAM_HEARTBEAT_MS);

  // Tear down on EVERY termination path. `cleanup` clears both interval timers,
  // so it MUST run whether the *request* stream closes (client FIN after the GET)
  // or the *response* stream closes (an aborted/RST socket, an upstream Envoy/nginx
  // idle reset, or an HTTP/2 stream reset). In Express 4 those are distinct events
  // and a response-side abort does not reliably fire `req`'s 'close' — so wiring
  // cleanup to `req` alone would orphan the 1s `pollTimer` (two Postgres queries
  // per tick) and the heartbeat writer FOREVER on this single, never-restarting
  // replica: a slow-burn DB/timer leak trivially triggered by opening then RST-ing
  // streams. `cleanup` is idempotent (the `closed` flag), so firing on both is
  // safe. Wired here, after the timers are declared, to avoid a TDZ on `pollTimer`
  // (the early `res.on('close', releaseSlot)` covers the pre-timer setup window).
  req.on('close', cleanup);
  res.on('close', cleanup);

  // Prime immediately so a client opening on an already-finished build gets
  // the full replay + `done` without waiting a poll interval.
  await poll();
});

export default router;
