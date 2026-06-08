import { BuildStatus, type Prisma } from '@prisma/client';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

import { prisma } from '../db.js';
import { HttpError } from '../lib/errors.js';

/**
 * Cross-project deployments feed — mounted at `/api/deployments`.
 * Aggregates every deployment across the caller's live projects so
 * the Deployments page renders one table instead of fan-out-per-project. Scoped
 * by `project.userId` so it never leaks another user's deployments.
 */
const router = Router();

const BUILD_STATUSES = new Set<string>(Object.values(BuildStatus));

// Upper bound on how many project ids a single feed request may filter on. The
// query is already user-scoped (`project.userId`), so this is a DB-load guard,
// not a security boundary: a 2000-char CSV could otherwise fan out to ~650 ids
// in one Prisma `IN (...)`. A user with more projects than this can page/filter
// in smaller batches.
const MAX_PROJECT_ID_FILTERS = 50;

// cuid-ish id shape, matching `idParamSchema` used by the other routers
// (z.string().min(1).max(40), lowercase-alnum). Malformed ids (anything outside
// this charset/length) are dropped before they reach Prisma.
const PROJECT_ID_RE = /^[a-z0-9]{1,40}$/;

const querySchema = z.object({
  // Comma-separated project ids to narrow the feed.
  projectId: z.string().max(2000).optional(),
  // Comma-separated BuildStatus values (filters on the deployment's build).
  status: z.string().max(200).optional(),
  activeOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(40).optional(),
});

function getUserId(req: Request): string {
  const id = req.user?.id;
  if (typeof id !== 'string') {
    throw new HttpError(401, 'UNAUTHENTICATED');
  }
  return id;
}

function parseCsv(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const values = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return values.length > 0 ? values : undefined;
}

/**
 * Parse the comma-separated `projectId` filter into a BOUNDED, VALIDATED list:
 * drop any token that isn't a well-formed cuid-ish id and cap the result at
 * {@link MAX_PROJECT_ID_FILTERS} so a single request can't fan out into a huge
 * Prisma `IN (...)`. Returns undefined when nothing valid remains (so the feed
 * falls back to the user-scoped default).
 */
function parseProjectIds(raw: string | undefined): string[] | undefined {
  const values = parseCsv(raw);
  if (values === undefined) return undefined;
  const valid = values
    .filter((id) => PROJECT_ID_RE.test(id))
    .slice(0, MAX_PROJECT_ID_FILTERS);
  return valid.length > 0 ? valid : undefined;
}

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = getUserId(req);
    const q = querySchema.parse(req.query);

    const where: Prisma.DeploymentWhereInput = {
      project: { userId, deletedAt: null },
    };
    const projectIds = parseProjectIds(q.projectId);
    if (projectIds) where.projectId = { in: projectIds };
    if (q.activeOnly) where.active = true;

    const statuses = parseCsv(q.status)
      ?.map((s) => s.toUpperCase())
      .filter((s) => BUILD_STATUSES.has(s)) as BuildStatus[] | undefined;
    if (statuses && statuses.length > 0) {
      where.build = { status: { in: statuses } };
    }

    const rows = await prisma.deployment.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
      include: {
        project: { select: { id: true, name: true, liveUrl: true } },
        build: true,
      },
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > q.limit;
    const items = (hasMore ? rows.slice(0, q.limit) : rows).map((d) => ({
      id: d.id,
      revisionName: d.revisionName,
      active: d.active,
      rolledBack: d.rolledBack,
      createdAt: d.createdAt,
      project: { id: d.project.id, name: d.project.name, liveUrl: d.project.liveUrl },
      build: {
        id: d.build.id,
        status: d.build.status,
        commitSha: d.build.commitSha,
        commitMessage: d.build.commitMessage,
        commitAuthor: d.build.commitAuthor,
        branch: d.build.branch,
      },
    }));

    res.json({
      items,
      nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
