// One-off seed script for manually triggering a builder end-to-end test
// without going through the GitHub OAuth + webhook path.
//
// Inserts: User (with crypto-encrypted fake GitHub token) -> Project
// (docker/welcome-to-docker @ main, target niikez-stub-test) -> Build
// (status QUEUED, head SHA). The prodstack-builder worker should claim
// the Build row within ~2 seconds and drive it to READY.
//
// Run from backend/ with: DATABASE_URL=... DATA_ENC_KEY=... node scripts/seed-test-build.mjs

import { createCipheriv, randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const REPO_FULL_NAME = 'GoogleCloudPlatform/cloud-run-hello';
const REPO_BRANCH = 'master';
const COMMIT_SHA = 'b58e53791f17ebe0809895c0660356a87473fd85';
const CONTAINER_APP_NAME = 'niikez-stub-test';

function encrypt(plaintext, keyB64) {
  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== 32) throw new Error(`DATA_ENC_KEY must decode to 32 bytes (got ${key.length})`);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: new Uint8Array(ciphertext),
    iv: new Uint8Array(iv),
    authTag: new Uint8Array(authTag),
    keyVersion: 1,
  };
}

const dek = process.env.DATA_ENC_KEY;
if (!dek) {
  console.error('DATA_ENC_KEY not set');
  process.exit(1);
}

const ghTok = encrypt('ghp_fakeTokenForPublicRepoTest', dek);
const whSecret = encrypt('not-used-for-this-test', dek);

const prisma = new PrismaClient();
try {
  // Idempotency: re-runnable. Clean up any prior test rows first.
  await prisma.build.deleteMany({ where: { project: { containerAppName: CONTAINER_APP_NAME } } });
  await prisma.deployment.deleteMany({ where: { project: { containerAppName: CONTAINER_APP_NAME } } });
  await prisma.project.deleteMany({ where: { containerAppName: CONTAINER_APP_NAME } });
  await prisma.user.deleteMany({ where: { githubLogin: 'builder-test-user' } });

  const user = await prisma.user.create({
    data: {
      githubUserId: 999000001,
      githubLogin: 'builder-test-user',
      email: 'test@example.invalid',
      githubTokenCiphertext: ghTok.ciphertext,
      githubTokenIv: ghTok.iv,
      githubTokenAuthTag: ghTok.authTag,
      githubTokenKeyVersion: ghTok.keyVersion,
    },
  });

  const project = await prisma.project.create({
    data: {
      userId: user.id,
      name: 'welcome-to-docker',
      slug: 'welcome-to-docker',
      githubRepoFullName: REPO_FULL_NAME,
      githubRepoId: 0,
      branch: REPO_BRANCH,
      webhookSecretCiphertext: whSecret.ciphertext,
      webhookSecretIv: whSecret.iv,
      webhookSecretAuthTag: whSecret.authTag,
      webhookSecretKeyVersion: whSecret.keyVersion,
      containerAppName: CONTAINER_APP_NAME,
    },
  });

  const build = await prisma.build.create({
    data: {
      projectId: project.id,
      commitSha: COMMIT_SHA,
      commitMessage: 'manual seed: docker/welcome-to-docker head',
      commitAuthor: 'builder-test-user',
      branch: REPO_BRANCH,
      status: 'QUEUED',
    },
  });

  console.log(JSON.stringify({ userId: user.id, projectId: project.id, buildId: build.id }, null, 2));
} finally {
  await prisma.$disconnect();
}
