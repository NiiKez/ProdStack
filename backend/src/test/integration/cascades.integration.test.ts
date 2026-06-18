// Real-Postgres integration tests for the onDelete: Cascade FKs.
//
// The mocked suite can't prove the FK actions are wired the way the schema
// declares them — only Postgres can. Here we delete a parent row and assert the
// child tables are physically empty (real cascade), plus the one SetNull edge
// (Build.previewId on PreviewEnvironment delete).

import { beforeEach, describe, expect, it } from 'vitest';

import { prisma } from '../../db.js';
import { createProject, createUser, truncateAll } from './helpers.js';

const dummy = () => Buffer.from('x');

/** Build a full graph rooted at a User: Project + Build + Deployment + LogLine
 *  + EnvVar + WebhookEvent + PreviewEnvironment (+ a preview-targeted Build). */
async function seedGraph(): Promise<{
  userId: string;
  projectId: string;
  buildId: string;
  previewId: string;
  previewBuildId: string;
}> {
  const userId = await createUser(prisma);
  const projectId = await createProject(prisma, userId);

  const build = await prisma.build.create({
    data: {
      projectId,
      commitSha: 'c',
      commitMessage: 'm',
      commitAuthor: 'a',
      branch: 'main',
      status: 'READY',
    },
  });
  await prisma.deployment.create({
    data: { projectId, buildId: build.id, revisionName: 'r1', active: true },
  });
  await prisma.logLine.createMany({
    data: [
      { buildId: build.id, seq: 1, message: 'hello' },
      { buildId: build.id, seq: 2, message: 'world' },
    ],
  });
  await prisma.envVar.create({
    data: {
      projectId,
      key: 'K',
      valueCiphertext: dummy(),
      valueIv: dummy(),
      valueAuthTag: dummy(),
    },
  });
  await prisma.webhookEvent.create({
    data: { id: `evt-${Math.random().toString(36).slice(2)}`, projectId },
  });
  const preview = await prisma.previewEnvironment.create({
    data: {
      projectId,
      prNumber: 1,
      title: 't',
      headRef: 'feat',
      headSha: 'sha',
      authorLogin: 'me',
      containerAppName: 'prev-1',
      expiresAt: new Date(Date.now() + 3600_000),
    },
  });
  // A build that targets the preview (Build.previewId -> SetNull on preview del).
  const previewBuild = await prisma.build.create({
    data: {
      projectId,
      previewId: preview.id,
      commitSha: 'c2',
      commitMessage: 'm2',
      commitAuthor: 'a2',
      branch: 'feat',
      status: 'READY',
    },
  });

  return { userId, projectId, buildId: build.id, previewId: preview.id, previewBuildId: previewBuild.id };
}

describe('cascade deletes (real Postgres)', () => {
  beforeEach(async () => {
    await truncateAll(prisma);
  });

  it('deleting a User cascades to Project and every grandchild table', async () => {
    const { userId, projectId, buildId, previewId } = await seedGraph();

    await prisma.user.delete({ where: { id: userId } });

    // Everything rooted under the user is gone.
    expect(await prisma.project.count()).toBe(0);
    expect(await prisma.build.count()).toBe(0);
    expect(await prisma.deployment.count()).toBe(0);
    expect(await prisma.logLine.count()).toBe(0);
    expect(await prisma.envVar.count()).toBe(0);
    expect(await prisma.webhookEvent.count()).toBe(0);
    expect(await prisma.previewEnvironment.count()).toBe(0);

    // Direct existence checks for the named rows too.
    expect(await prisma.project.findUnique({ where: { id: projectId } })).toBeNull();
    expect(await prisma.build.findUnique({ where: { id: buildId } })).toBeNull();
    expect(await prisma.previewEnvironment.findUnique({ where: { id: previewId } })).toBeNull();
  });

  it('deleting a Project cascades to its Builds/Deployments/LogLines/EnvVars/WebhookEvents/Previews but leaves the User', async () => {
    const { userId, projectId } = await seedGraph();

    await prisma.project.delete({ where: { id: projectId } });

    expect(await prisma.build.count()).toBe(0);
    expect(await prisma.deployment.count()).toBe(0);
    expect(await prisma.logLine.count()).toBe(0);
    expect(await prisma.envVar.count()).toBe(0);
    expect(await prisma.webhookEvent.count()).toBe(0);
    expect(await prisma.previewEnvironment.count()).toBe(0);

    // The user survives a project delete (cascade is one-directional).
    expect(await prisma.user.findUnique({ where: { id: userId } })).not.toBeNull();
  });

  it('deleting a Build with its own logs+deployment removes both (Build cascade)', async () => {
    const userId = await createUser(prisma);
    const projectId = await createProject(prisma, userId);
    const build = await prisma.build.create({
      data: {
        projectId,
        commitSha: 'c',
        commitMessage: 'm',
        commitAuthor: 'a',
        branch: 'main',
        status: 'READY',
      },
    });
    await prisma.logLine.createMany({
      data: [
        { buildId: build.id, seq: 1, message: 'a' },
        { buildId: build.id, seq: 2, message: 'b' },
        { buildId: build.id, seq: 3, message: 'c' },
      ],
    });
    await prisma.deployment.create({
      data: { projectId, buildId: build.id, revisionName: 'r', active: false },
    });

    expect(await prisma.logLine.count({ where: { buildId: build.id } })).toBe(3);
    expect(await prisma.deployment.count({ where: { buildId: build.id } })).toBe(1);

    await prisma.build.delete({ where: { id: build.id } });

    expect(await prisma.logLine.count({ where: { buildId: build.id } })).toBe(0);
    expect(await prisma.deployment.count({ where: { buildId: build.id } })).toBe(0);
    // Project survives.
    expect(await prisma.project.findUnique({ where: { id: projectId } })).not.toBeNull();
  });

  it('deleting a PreviewEnvironment sets Build.previewId to NULL (SetNull), keeping build history', async () => {
    const { previewId, previewBuildId } = await seedGraph();

    await prisma.previewEnvironment.delete({ where: { id: previewId } });

    const build = await prisma.build.findUnique({ where: { id: previewBuildId } });
    expect(build).not.toBeNull(); // build survives the preview teardown
    expect(build?.previewId).toBeNull(); // FK nulled, not cascaded
  });
});
