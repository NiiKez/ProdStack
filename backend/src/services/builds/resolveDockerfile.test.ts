import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GENERATED_DOCKERFILE_NAME,
  parseExposedPort,
  resolveDockerfile,
} from './resolveDockerfile.js';

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

  it('derives the ingress port from a repo Dockerfile EXPOSE', async () => {
    await writeFile(
      path.join(repoDir, 'Dockerfile'),
      'FROM node:20-alpine\nEXPOSE 3000\nCMD ["node", "server.js"]\n',
    );
    const res = await resolveDockerfile(repoDir, logs);
    expect(res.generated).toBe(false);
    expect(res.framework).toBeNull();
    expect(res.port).toBe(3000);
    expect(res.dockerfilePath).toBe(path.join(repoDir, 'Dockerfile'));
    // It must NOT rewrite the user's Dockerfile.
    const written = await readFile(res.dockerfilePath, 'utf8');
    expect(written).toContain('EXPOSE 3000');
    expect(logs.write).toHaveBeenCalledWith('STEP', expect.stringContaining('port 3000'));
  });

  it('warns and leaves ingress at default when a repo Dockerfile has no EXPOSE', async () => {
    await writeFile(path.join(repoDir, 'Dockerfile'), 'FROM nginx:alpine\n');
    const res = await resolveDockerfile(repoDir, logs);
    expect(res.generated).toBe(false);
    expect(res.port).toBeNull();
    expect(logs.write).toHaveBeenCalledWith('WARN', expect.stringContaining('no EXPOSE'));
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

  it('refuses to interpolate a hostile wsgi package dir name into the generated Dockerfile', async () => {
    // The wsgi package directory name is interpolated verbatim into the
    // generated gunicorn CMD. A repo controls its own dir names, and a POSIX
    // name may contain `"`, `$`, `;`, spaces — which could break out of the
    // JSON-array CMD and inject arbitrary Dockerfile directives. The name must
    // be a plain Python identifier; anything else is skipped and Django falls
    // back to the `manage.py runserver` template.
    const hostile = 'evil") ; RUN echo pwned ; #';
    await writeFile(path.join(repoDir, 'manage.py'), '# django');
    await writeFile(path.join(repoDir, 'requirements.txt'), 'Django==5.0');
    await mkdir(path.join(repoDir, hostile));
    await writeFile(path.join(repoDir, hostile, 'wsgi.py'), '# wsgi');

    const res = await resolveDockerfile(repoDir, logs);
    expect(res.framework).toBe('Django');
    const written = await readFile(res.dockerfilePath, 'utf8');
    // The injection payload never reaches the generated recipe…
    expect(written).not.toContain('RUN echo pwned');
    expect(written).not.toContain(hostile);
    expect(written).not.toMatch(/gunicorn .*\.wsgi/);
    // …and we fall back cleanly to the safe runserver template.
    expect(written).toContain('manage.py runserver');
  });

  it('throws a friendly error when nothing is detected', async () => {
    await writeFile(path.join(repoDir, 'README.md'), '# hi');
    await expect(resolveDockerfile(repoDir, logs)).rejects.toThrow(
      /could not be auto-detected/,
    );
  });

  it('declares build-time-public keys as ARGs in the generated Dockerfile', async () => {
    await writeFile(
      path.join(repoDir, 'package.json'),
      JSON.stringify({ dependencies: { next: '14' } }),
    );
    const res = await resolveDockerfile(repoDir, logs, {
      buildArgKeys: ['NEXT_PUBLIC_API_URL'],
    });
    expect(res.generated).toBe(true);
    const written = await readFile(res.dockerfilePath, 'utf8');
    expect(written).toContain('ARG NEXT_PUBLIC_API_URL');
    expect(written).toContain('ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL');
  });

  it('never rewrites a user Dockerfile, even when buildArgKeys are given', async () => {
    await writeFile(path.join(repoDir, 'Dockerfile'), 'FROM scratch\n');
    const res = await resolveDockerfile(repoDir, logs, { buildArgKeys: ['NEXT_PUBLIC_X'] });
    expect(res.generated).toBe(false);
    expect(res.dockerfilePath).toBe(path.join(repoDir, 'Dockerfile'));
    const written = await readFile(res.dockerfilePath, 'utf8');
    expect(written).toBe('FROM scratch\n');
  });
});

describe('parseExposedPort', () => {
  it('parses a bare EXPOSE port', () => {
    expect(parseExposedPort('FROM x\nEXPOSE 3000\n')).toBe(3000);
  });

  it('parses EXPOSE with a protocol suffix', () => {
    expect(parseExposedPort('EXPOSE 8080/tcp\n')).toBe(8080);
    expect(parseExposedPort('EXPOSE 5000/udp\n')).toBe(5000);
  });

  it('is case-insensitive on the instruction', () => {
    expect(parseExposedPort('expose 4321\n')).toBe(4321);
  });

  it('takes the first valid port when several are exposed', () => {
    expect(parseExposedPort('EXPOSE 8080 9090\n')).toBe(8080);
    expect(parseExposedPort('EXPOSE 7000\nEXPOSE 7001\n')).toBe(7000);
  });

  it('skips unresolvable values and falls back to the next numeric', () => {
    expect(parseExposedPort('EXPOSE ${PORT}\nEXPOSE 6000\n')).toBe(6000);
    expect(parseExposedPort('EXPOSE $PORT\n')).toBeNull();
  });

  it('ignores commented-out EXPOSE lines', () => {
    expect(parseExposedPort('# EXPOSE 3000\nEXPOSE 8000\n')).toBe(8000);
    expect(parseExposedPort('# EXPOSE 3000\n')).toBeNull();
  });

  it('returns null when there is no EXPOSE', () => {
    expect(parseExposedPort('FROM nginx:alpine\nCMD ["nginx"]\n')).toBeNull();
  });

  it('rejects out-of-range ports', () => {
    expect(parseExposedPort('EXPOSE 70000\n')).toBeNull();
    expect(parseExposedPort('EXPOSE 0\n')).toBeNull();
  });
});
