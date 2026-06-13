// Coverage for the kaniko ACR-credential-leak guard.
//
// `assertAuthDirIsolated` is the structural guard that stops a user's
// `COPY . .` Dockerfile from baking ACR push creds into the published image:
// it throws if the docker-config authDir lives at or inside the kaniko build
// context. `writeDockerConfig` writes `<authDir>/.docker/config.json` with
// base64(`ACR_USERNAME:ACR_PASSWORD`) auth for `<ACR_NAME>.azurecr.io` at mode
// 0o600.
//
// Both read `env.ACR_NAME`/`ACR_USERNAME`/`ACR_PASSWORD`, which are optional and
// UNSET in the test env (the global setup only seeds the 9 required vars +
// AZURE_STUB), so we set them via `vi.hoisted` — that block runs before the
// hoisted ESM imports below, so `env.ts` validates with them present — then
// dynamically import the module under test. Same pattern as
// `rateLimit.edge.test.ts`.
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const ACR_NAME = 'testacr';
const ACR_USERNAME = 'acruser';
const ACR_PASSWORD = 'acrpass';

vi.hoisted(() => {
  process.env.ACR_NAME = 'testacr';
  process.env.ACR_USERNAME = 'acruser';
  process.env.ACR_PASSWORD = 'acrpass';
});

const { assertAuthDirIsolated, writeDockerConfig } = await import('./kaniko.js');

describe('assertAuthDirIsolated', () => {
  it('throws when authDir === contextDir', () => {
    const dir = '/var/builds/b1/repo';
    expect(() => assertAuthDirIsolated(dir, dir)).toThrow(/leak|inside|context/i);
  });

  it('throws when authDir is directly inside contextDir', () => {
    expect(() =>
      assertAuthDirIsolated('/var/builds/b1/repo', '/var/builds/b1/repo/.docker'),
    ).toThrow(/leak|inside|context/i);
  });

  it('throws when authDir is nested deeper inside contextDir', () => {
    expect(() =>
      assertAuthDirIsolated('/var/builds/b1/repo', '/var/builds/b1/repo/nested/deep/.docker'),
    ).toThrow(/leak|inside|context/i);
  });

  it('does NOT throw for a sibling authDir', () => {
    expect(() =>
      assertAuthDirIsolated('/var/builds/b1/repo', '/var/builds/b1/auth'),
    ).not.toThrow();
  });

  it('does NOT throw for an unrelated absolute dir', () => {
    expect(() =>
      assertAuthDirIsolated('/var/builds/b1/repo', '/tmp/whatever'),
    ).not.toThrow();
  });
});

describe('writeDockerConfig', () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  it('writes base64 ACR basic-auth into <authDir>/.docker/config.json', async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kaniko-test-'));

    const dockerDir = await writeDockerConfig(tmpDir);
    expect(dockerDir).toBe(path.join(tmpDir, '.docker'));

    const configPath = path.join(dockerDir, 'config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));

    const registry = `${ACR_NAME}.azurecr.io`;
    const expectedAuth = Buffer.from(`${ACR_USERNAME}:${ACR_PASSWORD}`, 'utf8').toString('base64');
    expect(config.auths[registry].auth).toBe(expectedAuth);
  });

  it('writes config.json with mode 0o600', async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kaniko-test-'));

    const dockerDir = await writeDockerConfig(tmpDir);
    const configPath = path.join(dockerDir, 'config.json');

    const mode = (await stat(configPath)).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
