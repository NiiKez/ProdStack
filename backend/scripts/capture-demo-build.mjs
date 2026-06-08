// Capture a real build into the demo replay fixture (docs/DEMO_MODE.md §5.1).
//
// Given a build id, this dumps that build's LogLine rows (level + message, with a
// relative `atMs` from the first line's timestamp) plus a status timeline, in the
// exact `build-replay.json` shape the demo driver replays. Run it ONCE against the
// live DB after a real successful build, eyeball the output, and commit the result
// to backend/src/services/demo/fixtures/build-replay.json.
//
// This is a FUTURE/ops tool — it never runs in CI and is not imported by the app.
// It only READS the DB (no writes), so it's safe to run against prod.
//
// Run from backend/ with an .env that has DATABASE_URL:
//   node --env-file=.env scripts/capture-demo-build.mjs <buildId>
//   node --env-file=.env scripts/capture-demo-build.mjs <buildId> > /tmp/replay.json
//
// Notes:
//   - The status timeline is approximated from the build's lifecycle timestamps
//     (createdAt/startedAt/finishedAt) since we don't persist per-status times;
//     adjust the intermediate BUILDING/PUSHING/DEPLOYING anchors by hand if you
//     want them to line up with specific log lines.
//   - `liveUrlTemplate` / `imageTag` are emitted as editable placeholders — the
//     fixture's live URL is intentionally fake (never resolves to a real app).

import { PrismaClient } from '@prisma/client';

const buildId = process.argv[2];
if (!buildId) {
  console.error('usage: node --env-file=.env scripts/capture-demo-build.mjs <buildId>');
  process.exit(1);
}

const prisma = new PrismaClient();

try {
  const build = await prisma.build.findUnique({
    where: { id: buildId },
    include: { project: { select: { slug: true, frameworkHint: true } } },
  });
  if (!build) {
    console.error(`build ${buildId} not found`);
    process.exit(1);
  }

  const lines = await prisma.logLine.findMany({
    where: { buildId },
    orderBy: { seq: 'asc' },
    select: { level: true, message: true, ts: true },
  });
  if (lines.length === 0) {
    console.error(`build ${buildId} has no log lines to capture`);
    process.exit(1);
  }

  // Relative ms anchored at the first line's timestamp.
  const t0 = lines[0].ts.getTime();
  const rel = (d) => Math.max(0, d.getTime() - t0);

  const replayLines = lines.map((l) => ({
    level: l.level,
    message: l.message,
    atMs: rel(l.ts),
  }));

  // Approximate the status timeline from the build lifecycle. QUEUED at 0;
  // CLONING at startedAt; READY at finishedAt; BUILDING/PUSHING/DEPLOYING spread
  // across the middle as rough anchors (hand-tune if needed).
  const cloneMs = build.startedAt ? rel(build.startedAt) : 0;
  const endMs = build.finishedAt ? rel(build.finishedAt) : replayLines.at(-1).atMs;
  const span = Math.max(1, endMs - cloneMs);
  const statusTimeline = [
    { status: 'QUEUED', atMs: 0 },
    { status: 'CLONING', atMs: cloneMs },
    { status: 'BUILDING', atMs: cloneMs + Math.round(span * 0.05) },
    { status: 'PUSHING', atMs: cloneMs + Math.round(span * 0.75) },
    { status: 'DEPLOYING', atMs: cloneMs + Math.round(span * 0.92) },
    { status: 'READY', atMs: endMs },
  ];

  const fixture = {
    framework: build.project.frameworkHint ?? 'Express',
    liveUrlTemplate: 'https://{slug}.demo.prodstack.live',
    imageTag: `demo-${build.commitSha.slice(0, 7)}`,
    statusTimeline,
    lines: replayLines,
  };

  process.stdout.write(JSON.stringify(fixture, null, 2) + '\n');
} finally {
  await prisma.$disconnect();
}
