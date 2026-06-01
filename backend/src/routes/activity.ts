import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

import { prisma } from '../db.js';
import { HttpError } from '../lib/errors.js';

/**
 * Activity feed — mounted at `/api/activity` (PLAN.md M5 §3.11). There is no
 * dedicated events table; the feed is a **synthesized union of build,
 * deployment, and project events** (the three sources the milestone calls for).
 * We fetch a window from each source ordered by its primary timestamp, expand
 * rows into typed events, merge, sort newest-first, and page with a timestamp
 * cursor.
 *
 * Pagination is a keyset cursor on the composite `(timestamp, id)` (`?cursor=`),
 * not a bare timestamp — two events sharing a millisecond at a page boundary
 * would otherwise be silently dropped (`lt` excludes the sibling). The cursor is
 * an opaque base64url of `<ms>:<eventId>`; the next page takes events strictly
 * "before" it in `(ts desc, id desc)` order. The window over-fetch (limit × 4)
 * keeps a page complete even though one build expands into up to two events; a
 * very selective `type` filter can still under-fill a page (documented limit).
 *
 * Webhook-received and env-var-updated events from §3.11's wishlist are omitted:
 * neither is persisted as a queryable row, so there's nothing to source them
 * from without a real events table (out of M5 scope).
 */
const router = Router();

/** Opaque keyset cursor over `(event timestamp ms, event id)`. */
function encodeCursor(ev: { ts: string; id: string }): string {
  return Buffer.from(`${new Date(ev.ts).getTime()}:${ev.id}`).toString('base64url');
}

function decodeCursor(raw: string): { ms: number; id: string } | null {
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    const sep = decoded.indexOf(':');
    if (sep === -1) return null;
    const ms = Number(decoded.slice(0, sep));
    const id = decoded.slice(sep + 1);
    if (!Number.isFinite(ms) || id.length === 0) return null;
    return { ms, id };
  } catch {
    return null;
  }
}

type ActivityType =
  | 'build.queued'
  | 'build.succeeded'
  | 'build.failed'
  | 'build.cancelled'
  | 'deployment.created'
  | 'deployment.rollback'
  | 'project.created'
  | 'project.deleted';

interface ActivityEvent {
  id: string;
  type: ActivityType;
  ts: string;
  projectId: string;
  projectName: string;
  buildId?: string;
  commitSha?: string;
  commitMessage?: string;
  commitAuthor?: string;
}

const ALL_TYPES = new Set<string>([
  'build.queued',
  'build.succeeded',
  'build.failed',
  'build.cancelled',
  'deployment.created',
  'deployment.rollback',
  'project.created',
  'project.deleted',
]);

const querySchema = z.object({
  // Opaque keyset cursor from a previous page's `nextCursor`.
  cursor: z.string().min(1).max(200).optional(),
  projectId: z.string().min(1).max(40).optional(),
  // Comma-separated ActivityType values to narrow the feed.
  type: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

function getUserId(req: Request): string {
  const id = req.user?.id;
  if (typeof id !== 'string') {
    throw new HttpError(401, 'UNAUTHENTICATED');
  }
  return id;
}

const TERMINAL_EVENT: Record<string, ActivityType> = {
  READY: 'build.succeeded',
  FAILED: 'build.failed',
  CANCELLED: 'build.cancelled',
};

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = getUserId(req);
    const q = querySchema.parse(req.query);
    const cursor = q.cursor ? decodeCursor(q.cursor) : null;
    if (q.cursor && cursor === null) {
      throw new HttpError(400, 'INVALID_CURSOR');
    }
    const cursorDate = cursor ? new Date(cursor.ms) : null;

    const typeFilter = q.type
      ? new Set(
          q.type
            .split(',')
            .map((s) => s.trim())
            .filter((s) => ALL_TYPES.has(s)),
        )
      : null;

    // Over-fetch: a build expands into up to two events, so a window of
    // limit × 4 comfortably covers a full page after merge + filtering.
    const window = q.limit * 4;
    const projectScope = { userId, deletedAt: null } as const;
    // Every event for a row has ts >= its createdAt (build terminal events fire
    // at finishedAt >= createdAt; project.deleted fires at deletedAt >=
    // createdAt). So bounding builds/deployments/created-projects by
    // `createdAt <= cursorMs` is a safe superset for the cursor page; the exact
    // boundary is then enforced by the composite filter below. `deleted`
    // projects are sourced separately, bounded on `deletedAt`, so a project
    // created long ago but deleted recently still surfaces its deletion event.
    const createdBound = cursorDate ? { createdAt: { lte: cursorDate } } : {};

    const [builds, deployments, createdProjects, deletedProjects] = await Promise.all([
      prisma.build.findMany({
        where: { project: projectScope, ...createdBound },
        orderBy: { createdAt: 'desc' },
        take: window,
        include: { project: { select: { id: true, name: true } } },
      }),
      prisma.deployment.findMany({
        where: { project: projectScope, ...createdBound },
        orderBy: { createdAt: 'desc' },
        take: window,
        include: {
          project: { select: { id: true, name: true } },
          build: {
            select: { id: true, commitSha: true, commitMessage: true, commitAuthor: true },
          },
        },
      }),
      prisma.project.findMany({
        where: { userId, ...createdBound },
        orderBy: { createdAt: 'desc' },
        take: window,
      }),
      // Soft-deleted projects, bounded + ordered on `deletedAt` so deletion
      // events page correctly independent of when the project was created.
      prisma.project.findMany({
        where: {
          userId,
          deletedAt: cursorDate ? { not: null, lte: cursorDate } : { not: null },
        },
        orderBy: { deletedAt: 'desc' },
        take: window,
      }),
    ]);

    const events: ActivityEvent[] = [];

    for (const b of builds) {
      events.push({
        id: `build.queued:${b.id}`,
        type: 'build.queued',
        ts: b.createdAt.toISOString(),
        projectId: b.projectId,
        projectName: b.project.name,
        buildId: b.id,
        commitSha: b.commitSha,
        commitMessage: b.commitMessage,
        commitAuthor: b.commitAuthor,
      });
      const terminal = TERMINAL_EVENT[b.status];
      if (terminal && b.finishedAt) {
        events.push({
          id: `${terminal}:${b.id}`,
          type: terminal,
          ts: b.finishedAt.toISOString(),
          projectId: b.projectId,
          projectName: b.project.name,
          buildId: b.id,
          commitSha: b.commitSha,
          commitMessage: b.commitMessage,
          commitAuthor: b.commitAuthor,
        });
      }
    }

    for (const d of deployments) {
      events.push({
        id: `deployment:${d.id}`,
        type: d.rolledBack ? 'deployment.rollback' : 'deployment.created',
        ts: d.createdAt.toISOString(),
        projectId: d.projectId,
        projectName: d.project.name,
        buildId: d.build.id,
        commitSha: d.build.commitSha,
        commitMessage: d.build.commitMessage,
        commitAuthor: d.build.commitAuthor,
      });
    }

    for (const p of createdProjects) {
      events.push({
        id: `project.created:${p.id}`,
        type: 'project.created',
        ts: p.createdAt.toISOString(),
        projectId: p.id,
        projectName: p.name,
      });
    }

    for (const p of deletedProjects) {
      if (!p.deletedAt) continue;
      events.push({
        id: `project.deleted:${p.id}`,
        type: 'project.deleted',
        ts: p.deletedAt.toISOString(),
        projectId: p.id,
        projectName: p.name,
      });
    }

    const beforeCursor = (e: ActivityEvent): boolean => {
      if (!cursor) return true;
      const ms = new Date(e.ts).getTime();
      // Strictly before the cursor in (ts desc, id desc) order.
      return ms < cursor.ms || (ms === cursor.ms && e.id < cursor.id);
    };

    const filtered = events
      .filter(beforeCursor)
      .filter((e) => (q.projectId ? e.projectId === q.projectId : true))
      .filter((e) => (typeFilter ? typeFilter.has(e.type) : true))
      .sort((a, b) => {
        const am = new Date(a.ts).getTime();
        const bm = new Date(b.ts).getTime();
        if (am !== bm) return bm - am;
        // Tiebreak by id descending so the keyset cursor is unambiguous.
        return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
      });

    const hasMore = filtered.length > q.limit;
    const items = hasMore ? filtered.slice(0, q.limit) : filtered;
    const last = items[items.length - 1];
    res.json({
      items,
      nextCursor: hasMore && last ? encodeCursor(last) : null,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
