/**
 * Runtime smoke test for the M4 SSE log stream against the REAL local
 * Postgres (docker compose). Boots the API + in-process stub worker, seeds a
 * QUEUED build, opens the SSE endpoint with a forged session cookie, and
 * prints every event until `done`. Asserts the build reaches READY and that
 * log + status + done events all arrived.
 *
 * Run from backend/:
 *   ENABLE_WORKER=true BUILD_RUNNER_MODE=stub AZURE_STUB=true \
 *     npx tsx --env-file=.env scripts/smoke-sse.ts
 */
import { get as httpGet } from 'node:http';

import { sign as signCookie } from 'cookie-signature';

import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { env } from '../src/env.js';
import { signSession } from '../src/lib/jwt.js';
import { encrypt } from '../src/lib/crypto.js';
import { startWorker } from '../src/services/builds/worker.js';

/**
 * Forge the exact cookie `cookie-parser` expects for a signed `session`:
 * `s:` + cookie-signature(jwt, COOKIE_SECRET), URL-encoded the way express's
 * `res.cookie(..., { signed: true })` serializes it.
 */
function sessionCookie(userId: string): string {
  const value = 's:' + signCookie(signSession(userId), env.COOKIE_SECRET);
  return `session=${encodeURIComponent(value)}`;
}

const CONTAINER_APP_NAME = 'smoke-sse-test';

async function seed(): Promise<{ userId: string; buildId: string }> {
  await prisma.build.deleteMany({ where: { project: { containerAppName: CONTAINER_APP_NAME } } });
  await prisma.deployment.deleteMany({ where: { project: { containerAppName: CONTAINER_APP_NAME } } });
  await prisma.project.deleteMany({ where: { containerAppName: CONTAINER_APP_NAME } });
  await prisma.user.deleteMany({ where: { githubLogin: 'smoke-sse-user' } });

  const tok = encrypt('ghp_fakeForSmoke');
  const secret = encrypt('smoke-secret');
  const user = await prisma.user.create({
    data: {
      githubUserId: 999000777,
      githubLogin: 'smoke-sse-user',
      githubTokenCiphertext: tok.ciphertext,
      githubTokenIv: tok.iv,
      githubTokenAuthTag: tok.authTag,
      githubTokenKeyVersion: tok.keyVersion,
    },
  });
  const project = await prisma.project.create({
    data: {
      userId: user.id,
      name: 'smoke',
      slug: 'smoke',
      githubRepoFullName: 'octocat/smoke',
      githubRepoId: 0,
      branch: 'main',
      webhookSecretCiphertext: secret.ciphertext,
      webhookSecretIv: secret.iv,
      webhookSecretAuthTag: secret.authTag,
      webhookSecretKeyVersion: secret.keyVersion,
      containerAppName: CONTAINER_APP_NAME,
    },
  });
  const build = await prisma.build.create({
    data: {
      projectId: project.id,
      commitSha: 'abc1234deadbeef',
      commitMessage: 'smoke test commit',
      commitAuthor: 'smoke-sse-user',
      branch: 'main',
      status: 'QUEUED',
    },
  });
  return { userId: user.id, buildId: build.id };
}

function streamUntilDone(port: number, buildId: string, userId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpGet(
      {
        host: '127.0.0.1',
        port,
        path: `/api/builds/${buildId}/logs/stream`,
        headers: { Cookie: sessionCookie(userId) },
      },
      (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`SSE handshake failed: HTTP ${res.statusCode}`));
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
          process.stdout.write(chunk);
          if (body.includes('event: done')) {
            req.destroy();
            resolve(body);
          }
        });
        res.on('end', () => resolve(body));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    setTimeout(() => {
      req.destroy();
      reject(new Error('smoke SSE timed out after 30s'));
    }, 30_000);
  });
}

async function main(): Promise<void> {
  console.log(`[smoke] runner mode=${env.BUILD_RUNNER_MODE} worker=${env.ENABLE_WORKER} azureStub=${env.AZURE_STUB}`);
  const { userId, buildId } = await seed();
  console.log(`[smoke] seeded buildId=${buildId}`);

  const app = createApp();
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as { port: number }).port;
  const worker = startWorker();

  try {
    const body = await streamUntilDone(port, buildId, userId);
    const final = await prisma.build.findUniqueOrThrow({ where: { id: buildId } });

    const checks = {
      gotStatus: body.includes('event: status'),
      gotLog: body.includes('event: log'),
      gotDone: body.includes('event: done'),
      sawBuilding: body.includes('"status":"BUILDING"') || body.includes('"status":"DEPLOYING"'),
      reachedReady: final.status === 'READY',
    };
    console.log('\n[smoke] checks:', JSON.stringify(checks, null, 2));
    const ok = Object.values(checks).every(Boolean);
    console.log(ok ? '[smoke] PASS ✅' : '[smoke] FAIL ❌');
    process.exitCode = ok ? 0 : 1;
  } finally {
    await worker.stop().catch(() => {});
    server.close();
    await prisma.$disconnect();
  }
}

void main();
