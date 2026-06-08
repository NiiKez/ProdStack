/**
 * Demo build driver — the "convincing trick" (docs/DEMO_MODE.md §5.2).
 *
 * A demo build is NOT a real build: nothing here clones a repo, runs Kaniko, or
 * touches Azure/ACR/git. The driver simply REPLAYS a captured fixture of a real
 * successful build (`fixtures/build-replay.json`) into Postgres on the recorded
 * cadence — it writes `LogLine` rows with a monotonic `seq` and advances
 * `Build.status` through the captured timeline. The existing SSE endpoint
 * (`GET /api/builds/:id/logs/stream`) reads those rows and streams them
 * byte-identically to a real build, so the demo viewer is indistinguishable
 * from the genuine pipeline — at zero Azure cost and zero RCE surface.
 *
 * CORE INVARIANT: this module imports NO Azure / git / Kaniko code. It only ever
 * writes DB rows. That is the load-bearing fail-closed property (§4) — a demo
 * session is *structurally* unable to reach a real build operation, not merely
 * flag-gated.
 *
 * The terminal-READY transaction mirrors `deployAndRecord` (runBuild.ts) so a
 * finished demo build looks exactly like a finished real one: a fresh active
 * Deployment, the prior one deactivated, `Build.status=READY` + timing, and the
 * project's `liveUrl` set.
 */
import type { BuildStatus, LogLevel } from '@prisma/client';

import { prisma } from '../../db.js';
import { env } from '../../env.js';
import { logger } from '../../lib/logger.js';
import replayFixture from './fixtures/build-replay.json' with { type: 'json' };

// --- Fixture shape ---------------------------------------------------------

/** One captured log line: level + message, anchored at `atMs` from build start. */
export interface ReplayLine {
  level: LogLevel;
  message: string;
  atMs: number;
}

/** One captured status transition, anchored at `atMs` from build start. */
export interface ReplayStatus {
  status: BuildStatus;
  atMs: number;
}

/** The whole captured-build fixture (see `fixtures/build-replay.json`). */
export interface BuildReplayFixture {
  framework: string;
  /** `liveUrlTemplate` with a `{slug}` placeholder substituted at finalize. */
  liveUrlTemplate: string;
  imageTag: string;
  lines: ReplayLine[];
  statusTimeline: ReplayStatus[];
}

/**
 * Typed view of the imported JSON. `resolveJsonModule` infers a wide literal
 * type from the file; we narrow it once here so the rest of the module gets the
 * `LogLevel`/`BuildStatus` enums instead of raw strings.
 */
export const fixture: BuildReplayFixture = replayFixture as BuildReplayFixture;

/** Default production sleep — real wall-clock delay. Tests inject a no-op. */
const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });

/** In-flight demo statuses the boot-recovery hook fast-forwards to READY. */
const IN_FLIGHT: BuildStatus[] = ['CLONING', 'BUILDING', 'PUSHING', 'DEPLOYING'];

/** Terminal build statuses — a finalize/fail must never clobber one of these. */
const TERMINAL_STATUSES: BuildStatus[] = ['READY', 'FAILED', 'CANCELLED'];

/**
 * Single-winner finalize: flip the build to READY only if it isn't already
 * terminal, and create the active Deployment ONLY for the writer that won the
 * flip. This makes the terminal transaction idempotent and race-free when a
 * live in-process replay and the boot recovery (`recoverDemoBuilds`) both try to
 * finish the same build (e.g. a scale-to-zero revision overlap). Without the
 * conditional flip both writers would deactivate+create an active Deployment and
 * collide on the `one_active_per_project` partial unique index. Mirrors
 * `deployAndRecord` (runBuild.ts) but DB-only. Returns true iff THIS call did
 * the finalize.
 */
async function finalizeDemoBuild(build: {
  id: string;
  projectId: string;
  startedAt: Date | null;
  project: { slug: string; containerAppName: string };
}): Promise<boolean> {
  const finishedAt = new Date();
  const startedAtMs = build.startedAt?.getTime() ?? finishedAt.getTime();
  const durationMs = Math.max(0, finishedAt.getTime() - startedAtMs);
  const liveUrl = substituteSlug(fixture.liveUrlTemplate, build.project.slug);
  const revisionName = `${build.project.containerAppName}--demo-${build.id.slice(0, 8)}`;

  return prisma.$transaction(async (tx) => {
    const flip = await tx.build.updateMany({
      where: { id: build.id, status: { notIn: TERMINAL_STATUSES } },
      data: { status: 'READY', finishedAt, durationMs, imageTag: fixture.imageTag },
    });
    // Another writer already finalized this build — bail before touching the
    // active deployment so we never create a second active row.
    if (flip.count === 0) return false;

    await tx.deployment.updateMany({
      where: { projectId: build.projectId, active: true },
      data: { active: false },
    });
    await tx.deployment.create({
      data: { projectId: build.projectId, buildId: build.id, revisionName, active: true },
    });
    await tx.project.update({
      where: { id: build.projectId },
      data: { liveUrl, frameworkHint: fixture.framework },
    });
    return true;
  });
}

/**
 * Replay the captured build into Postgres for `buildId`. Awaitable; `opts.sleep`
 * is injectable so tests run the whole replay instantly and deterministically
 * (`sleep: () => Promise.resolve()`), while production uses a real `setTimeout`.
 *
 * The Build row must already exist, pre-claimed and `isDemo=true`, at status
 * QUEUED — the orchestrator (`startDemoBuild`) creates it that way so the Kaniko
 * worker can never claim it (§4 layer 1).
 *
 * Cadence: each gap between fixture events is divided by `DEMO_REPLAY_SPEED`
 * (default 6× → the ~90s capture replays in ~15s). Lines are written as their
 * `atMs` is reached, with a monotonic `seq` starting at 1; the status advances
 * at each timeline point. On the terminal READY we run the same transaction
 * shape as `deployAndRecord`.
 */
export async function runDemoReplay(
  buildId: string,
  opts: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const sleep = opts.sleep ?? realSleep;
  const speed = env.DEMO_REPLAY_SPEED > 0 ? env.DEMO_REPLAY_SPEED : 1;

  const build = await prisma.build.findUniqueOrThrow({
    where: { id: buildId },
    include: { project: true },
  });

  // Merge lines + status transitions into one timeline sorted by atMs, so we
  // sleep once between consecutive events and apply each in capture order. The
  // terminal READY status is handled specially (the deploy transaction), so we
  // drop it from the generic status stream.
  type Event =
    | { kind: 'line'; atMs: number; line: ReplayLine }
    | { kind: 'status'; atMs: number; status: BuildStatus };

  const events: Event[] = [
    ...fixture.lines.map((line): Event => ({ kind: 'line', atMs: line.atMs, line })),
    ...fixture.statusTimeline
      .filter((s) => s.status !== 'QUEUED' && s.status !== 'READY')
      .map((s): Event => ({ kind: 'status', atMs: s.atMs, status: s.status })),
  ].sort((a, b) => a.atMs - b.atMs);

  const startedAt = new Date();
  await prisma.build.update({ where: { id: buildId }, data: { startedAt } });

  // Start `seq` after any LogLine rows already attached to this build so a
  // re-driven build (or seeded lines) can't collide on the `(buildId, seq)`
  // unique index. Fresh build → max is null → seq starts at 1.
  const maxSeq = await prisma.logLine.aggregate({ where: { buildId }, _max: { seq: true } });
  let seq = (maxSeq._max.seq ?? 0) + 1;

  try {
    let prevMs = 0;
    for (const ev of events) {
      const deltaMs = Math.max(0, ev.atMs - prevMs);
      if (deltaMs > 0) {
        await sleep(deltaMs / speed);
      }
      prevMs = ev.atMs;

      if (ev.kind === 'status') {
        await prisma.build.update({ where: { id: buildId }, data: { status: ev.status } });
      } else {
        await prisma.logLine.create({
          data: {
            buildId,
            seq: seq++,
            level: ev.line.level,
            message: substituteSlug(ev.line.message, build.project.slug),
          },
        });
      }
    }

    // Terminal READY: single-winner finalize (deactivate prior deployment,
    // create the active one, mark READY + timing + image tag, set liveUrl +
    // framework) — DB-only, idempotent, race-safe (see finalizeDemoBuild).
    const finalized = await finalizeDemoBuild({
      id: buildId,
      projectId: build.projectId,
      startedAt,
      project: build.project,
    });
    logger.info({ buildId, finalized }, 'demo build replay complete');
  } catch (err) {
    // Mark the build FAILED (conditionally — never clobber a terminal state) so
    // the SSE viewer resolves immediately instead of hanging "Building…" until
    // the next boot recovery. Re-throw so startDemoReplay logs it.
    await prisma.build
      .updateMany({
        where: { id: buildId, status: { notIn: TERMINAL_STATUSES } },
        data: { status: 'FAILED', finishedAt: new Date(), errorMessage: 'demo replay error' },
      })
      .catch(() => undefined);
    throw err;
  }
}

/** Replace the `{slug}` placeholder in a fixture string with the project slug. */
function substituteSlug(template: string, slug: string): string {
  return template.split('{slug}').join(slug);
}

/**
 * Fire-and-forget launcher used by the orchestrator: kicks `runDemoReplay` with
 * the real `setTimeout` cadence and swallows (but logs) any error so an unhandled
 * rejection can't crash the API process. The visitor's open SSE connection keeps
 * the (scale-to-zero) replica warm for the short replay; the boot-recovery hook
 * (`recoverDemoBuilds`) is the backstop if the replica is torn down mid-replay.
 */
export function startDemoReplay(buildId: string): void {
  void runDemoReplay(buildId).catch((err: unknown) => {
    logger.error({ err, buildId }, 'demo build replay failed');
  });
}

/**
 * API-boot recovery — the demo analogue of the worker's `recoverOwnClaims`.
 * Scale-to-zero can tear down the API replica mid-replay, leaving a demo build
 * stuck at CLONING/BUILDING/PUSHING/DEPLOYING forever. On boot we fast-forward
 * every in-flight DEMO build straight to READY (with an active deployment +
 * liveUrl) so no sandbox build hangs "Building…". Scoped strictly to
 * `isDemo=true` rows, so it can never touch a real build. Each finalize is
 * single-winner (see finalizeDemoBuild), so racing a still-running in-process
 * replay is safe.
 *
 * Returns the number of demo builds this call actually finalized (a build a live
 * replay already finished is skipped, not double-counted). Gated by `ENABLE_DEMO`
 * at the call site (index.ts).
 */
export async function recoverDemoBuilds(): Promise<number> {
  const stuck = await prisma.build.findMany({
    where: { isDemo: true, status: { in: IN_FLIGHT } },
    include: { project: true },
  });

  let recovered = 0;
  for (const build of stuck) {
    // No point finalizing a deployment for a soft-deleted project.
    if (build.project.deletedAt !== null) continue;
    try {
      // Per-build isolation: one failure (e.g. a finalize the live replay just
      // won) must not abort recovery of the rest of the batch. The single-winner
      // finalize means a build a live replay is still finishing is a harmless
      // no-op here (flip.count === 0 → returns false).
      const finalized = await finalizeDemoBuild(build);
      if (finalized) recovered++;
    } catch (err) {
      logger.error({ err, buildId: build.id }, 'demo build recovery failed for build');
    }
  }

  return recovered;
}
