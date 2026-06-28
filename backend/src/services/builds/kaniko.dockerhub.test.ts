// Coverage for the OPTIONAL Docker Hub pull-auth entry in the kaniko docker
// config (writeDockerConfig). Generated/user Dockerfiles pull their base image
// (`FROM node:20-slim`, …) from Docker Hub, which rate-limits ANONYMOUS pulls
// per source IP; the builder shares Azure's egress IP pool, so anonymous pulls
// intermittently hit `TOOMANYREQUESTS`. When DOCKERHUB_USERNAME/TOKEN are set,
// writeDockerConfig adds an authenticated `https://index.docker.io/v1/` entry so
// pulls count against the account, not the shared IP.
//
// env vars are validated once at import, so the WITH-creds branch needs its own
// test file (frozen env) — the WITHOUT-creds branch is covered in
// kaniko.authDir.test.ts. Same vi.hoisted pattern as that file.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const ACR_NAME = 'testacr';
const ACR_USERNAME = 'acruser';
const ACR_PASSWORD = 'acrpass';
const DOCKERHUB_USERNAME = 'hubuser';
const DOCKERHUB_TOKEN = 'hubtoken';

vi.hoisted(() => {
  process.env.ACR_NAME = 'testacr';
  process.env.ACR_USERNAME = 'acruser';
  process.env.ACR_PASSWORD = 'acrpass';
  process.env.DOCKERHUB_USERNAME = 'hubuser';
  process.env.DOCKERHUB_TOKEN = 'hubtoken';
});

const { writeDockerConfig } = await import('./kaniko.js');

describe('writeDockerConfig — Docker Hub pull auth', () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  it('adds an authenticated index.docker.io entry under the canonical key', async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kaniko-hub-'));
    const dockerDir = await writeDockerConfig(tmpDir);
    const config = JSON.parse(await readFile(path.join(dockerDir, 'config.json'), 'utf8'));

    const expected = Buffer.from(
      `${DOCKERHUB_USERNAME}:${DOCKERHUB_TOKEN}`,
      'utf8',
    ).toString('base64');
    // The key MUST be exactly this — go-containerregistry resolves Docker Hub
    // against it; `docker.io` / `index.docker.io` would be ignored.
    expect(config.auths['https://index.docker.io/v1/'].auth).toBe(expected);
  });

  it('keeps the ACR push-auth entry alongside the Docker Hub pull-auth entry', async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kaniko-hub-'));
    const dockerDir = await writeDockerConfig(tmpDir);
    const config = JSON.parse(await readFile(path.join(dockerDir, 'config.json'), 'utf8'));

    const registry = `${ACR_NAME}.azurecr.io`;
    const expectedAcr = Buffer.from(
      `${ACR_USERNAME}:${ACR_PASSWORD}`,
      'utf8',
    ).toString('base64');
    expect(config.auths[registry].auth).toBe(expectedAcr);
    expect(Object.keys(config.auths).sort()).toEqual(
      [`${ACR_NAME}.azurecr.io`, 'https://index.docker.io/v1/'].sort(),
    );
  });
});
