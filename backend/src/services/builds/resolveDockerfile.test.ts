import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GENERATED_DOCKERFILE_NAME, resolveDockerfile } from './resolveDockerfile.js';

let repoDir: string;
const logs = { write: vi.fn().mockResolvedValue(undefined) };

beforeEach(async () => {
  logs.write.mockClear();
  repoDir = await mkdtemp(path.join(tmpdir(), 'prodstack-resolve-'));
});

afterEach(async () => {
  await rm(repoDir, { recursive: true, force: true });
});

describe('resolveDockerfile', () => {
  it('uses the repo Dockerfile verbatim when present (user wins)', async () => {
    await writeFile(path.join(repoDir, 'Dockerfile'), 'FROM scratch\n');
    const res = await resolveDockerfile(repoDir, logs);
    expect(res.generated).toBe(false);
    expect(res.framework).toBeNull();
    expect(res.port).toBeNull();
    expect(res.dockerfilePath).toBe(path.join(repoDir, 'Dockerfile'));
  });

  it('generates a Dockerfile for a detected Node app and writes it into the context', async () => {
    await writeFile(
      path.join(repoDir, 'package.json'),
      JSON.stringify({ dependencies: { express: '4' }, scripts: { start: 'node i.js' } }),
    );
    const res = await resolveDockerfile(repoDir, logs);
    expect(res.generated).toBe(true);
    expect(res.framework).toBe('Node.js (Express)');
    expect(res.port).toBe(3000);
    expect(res.dockerfilePath).toBe(path.join(repoDir, GENERATED_DOCKERFILE_NAME));
    const written = await readFile(res.dockerfilePath, 'utf8');
    expect(written).toContain('CMD ["npm", "start"]');
  });

  it('tolerates a malformed package.json (treats it as absent)', async () => {
    await writeFile(path.join(repoDir, 'package.json'), '{ not json');
    await writeFile(path.join(repoDir, 'index.html'), '<html></html>');
    // Falls through Node detection (bad JSON) to the static-site branch.
    const res = await resolveDockerfile(repoDir, logs);
    expect(res.framework).toBe('Static site');
  });

  it('discovers a Django wsgi module one level deep', async () => {
    await writeFile(path.join(repoDir, 'manage.py'), '# django');
    await writeFile(path.join(repoDir, 'requirements.txt'), 'Django==5.0');
    await mkdir(path.join(repoDir, 'myproj'));
    await writeFile(path.join(repoDir, 'myproj', 'wsgi.py'), '# wsgi');
    const res = await resolveDockerfile(repoDir, logs);
    expect(res.framework).toBe('Django');
    const written = await readFile(res.dockerfilePath, 'utf8');
    expect(written).toContain('gunicorn myproj.wsgi:application');
  });

  it('throws a friendly error when nothing is detected', async () => {
    await writeFile(path.join(repoDir, 'README.md'), '# hi');
    await expect(resolveDockerfile(repoDir, logs)).rejects.toThrow(
      /could not be auto-detected/,
    );
  });
});
