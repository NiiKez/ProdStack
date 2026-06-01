import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

import { prisma } from '../db.js';
import { HttpError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

/**
 * Builds router — mounted under `/api/builds` (behind requireAuth). M4 of
 * PLAN.md (§2.8 + §2.9 read paths):
 *
 *   GET /:id              build detail (ownership-checked)
 *   GET /:id/logs         paginated log lines for non-live viewing
 *   GET /:id/logs/stream  SSE: replay-from-cursor → live tail → done
 *
 * ## Why the SSE endpoint tails Postgres instead of an in-process EventEmitter
 *
 * PLAN.md §2.8 assumed a single API replica that both runs the build and
 * serves the stream, so an in-process pub/sub would do. That assumption is
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
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['READY', 'FAILED', 'CANCELLED']);

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

// --- GET /api/builds/:id/logs/stream (SSE) ---------------------------------

router.get('/:id/logs/stream', async (req: Request, res: Response) => {
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

  const build = await findOwnedBuild(buildId, userId);
  if (build === null) {
    res.status(404).json({ error: 'BUILD_NOT_FOUND' });
    return;
  }

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

  const poll = async (): Promise<void> => {
    if (closed) return;
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
    }
  };

  const pollTimer = setInterval(() => void poll(), STREAM_POLL_MS);
  const heartbeatTimer = setInterval(() => write(':hb\n\n'), STREAM_HEARTBEAT_MS);

  req.on('close', cleanup);

  // Prime immediately so a client opening on an already-finished build gets
  // the full replay + `done` without waiting a poll interval.
  await poll();
});

export default router;
