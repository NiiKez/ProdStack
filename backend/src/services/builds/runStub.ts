import { Prisma, type BuildStatus, type LogLevel } from '@prisma/client';

import { prisma } from '../../db.js';
import { logger } from '../../lib/logger.js';
import { updateContainerApp } from '../azure/index.js';

const STUB_IMAGES = [
  'mcr.microsoft.com/k8se/quickstart:latest',
  'nginxdemos/hello:latest',
] as const;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function appendLog(
  buildId: string,
  seq: number,
  level: LogLevel,
  message: string,
): Promise<void> {
  await prisma.logLine.create({ data: { buildId, seq, level, message } });
}

async function setStatus(
  buildId: string,
  status: BuildStatus,
  extra: Prisma.BuildUpdateInput = {},
): Promise<void> {
  await prisma.build.update({ where: { id: buildId }, data: { status, ...extra } });
}

export async function runStubBuild(buildId: string): Promise<void> {
  const build = await prisma.build.findUniqueOrThrow({
    where: { id: buildId },
    include: { project: true },
  });

  const startedAt = new Date();
  const image = STUB_IMAGES[build.commitSha.charCodeAt(0) % STUB_IMAGES.length];

  try {
    await setStatus(buildId, 'CLONING', { startedAt });
    await appendLog(
      buildId,
      1,
      'INFO',
      `stub: cloning ${build.project.githubRepoFullName}@${build.commitSha.slice(0, 7)}`,
    );
    await sleep(1500);

    await setStatus(buildId, 'BUILDING');
    await appendLog(buildId, 2, 'INFO', `stub: pretending to build (target image=${image})`);
    await sleep(1500);

    await setStatus(buildId, 'DEPLOYING', { imageTag: image });
    await appendLog(
      buildId,
      3,
      'INFO',
      `stub: rolling ${build.project.containerAppName} to ${image}`,
    );
    const result = await updateContainerApp({
      name: build.project.containerAppName,
      image,
    });

    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - startedAt.getTime();

    await prisma.$transaction([
      prisma.deployment.updateMany({
        where: { projectId: build.projectId, active: true },
        data: { active: false },
      }),
      prisma.deployment.create({
        data: {
          projectId: build.projectId,
          buildId: build.id,
          revisionName: 'stub',
          active: true,
        },
      }),
      prisma.build.update({
        where: { id: buildId },
        data: { status: 'READY', finishedAt, durationMs },
      }),
      prisma.project.update({
        where: { id: build.projectId },
        data: { liveUrl: result.liveUrl },
      }),
    ]);

    await appendLog(buildId, 4, 'SUCCESS', `stub: deployed → ${result.liveUrl}`);
    logger.info(
      { buildId, image, liveUrl: result.liveUrl },
      'stub build complete',
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await setStatus(buildId, 'FAILED', { finishedAt: new Date(), errorMessage: message });
    await appendLog(buildId, 999, 'ERROR', `stub: failed — ${message}`);
    logger.error({ err, buildId }, 'stub build failed');
  }
}
