import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// M2/M3 security review findings (round 2): container images must be hardened
// against (a) running as root where avoidable and (b) mutable/unpinned base
// images. These tests pin the three Dockerfiles so a regression — dropping the
// non-root USER, un-pinning a base image, reintroducing a floating :latest, or
// silently removing the documented kaniko-root exception — is caught in CI.
//
// frontend/ is the vitest rootDir; the Dockerfiles live one level up at the
// monorepo root (each app's Dockerfile sits in its own workspace dir).
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

function readDockerfile(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

const BACKEND = readDockerfile('backend/Dockerfile');
const FRONTEND = readDockerfile('frontend/Dockerfile');
const WORKER = readDockerfile('worker/Dockerfile');

const ALL = { backend: BACKEND, frontend: FRONTEND, worker: WORKER };

// Match the instruction part of a `FROM` line, ignoring trailing `# comment`.
function fromLines(dockerfile: string): string[] {
  return dockerfile
    .split('\n')
    .map((l) => l.replace(/#.*$/, '').trim())
    .filter((l) => /^FROM\s+/i.test(l));
}

describe('Dockerfile base-image pinning (M3)', () => {
  for (const [name, contents] of Object.entries(ALL)) {
    describe(name, () => {
      const froms = fromLines(contents);

      it('has at least one FROM line', () => {
        expect(froms.length).toBeGreaterThan(0);
      });

      it('pins every FROM to an immutable @sha256 digest', () => {
        for (const line of froms) {
          expect(line, `unpinned FROM: ${line}`).toMatch(/@sha256:[0-9a-f]{64}\b/);
        }
      });

      it('never uses a floating :latest tag', () => {
        for (const line of froms) {
          expect(line, `floating :latest FROM: ${line}`).not.toMatch(/:latest(\b|@)/);
        }
      });
    });
  }
});

describe('Non-root USER (M2)', () => {
  it('backend runner stage drops to the non-root `node` user', () => {
    // The USER directive must appear after the `AS runner` stage starts and
    // before the ENTRYPOINT, so the migrate-on-boot + node server run as node.
    expect(BACKEND).toMatch(/^USER node\s*$/m);
    const runnerIdx = BACKEND.indexOf('AS runner');
    const userIdx = BACKEND.indexOf('USER node');
    const entrypointIdx = BACKEND.indexOf('ENTRYPOINT');
    expect(runnerIdx).toBeGreaterThan(-1);
    expect(userIdx).toBeGreaterThan(runnerIdx);
    expect(userIdx).toBeLessThan(entrypointIdx);
  });

  it('frontend runner stage runs fully non-root as uid 101 (nginx-unprivileged)', () => {
    // The web runtime is nginxinc/nginx-unprivileged: the WHOLE stack (master +
    // workers) runs as uid 101, not just the workers. The explicit `USER 101`
    // both restates that and makes Trivy's Dockerfile scan (AVD-DS-0002) pass,
    // since it doesn't resolve the base image's USER. It must come after the
    // runner stage starts.
    expect(FRONTEND).toMatch(/^USER 101\s*$/m);
    const runnerIdx = FRONTEND.indexOf('AS runner');
    const userIdx = FRONTEND.indexOf('USER 101');
    expect(runnerIdx).toBeGreaterThan(-1);
    expect(userIdx).toBeGreaterThan(runnerIdx);
  });
});

describe('worker kaniko-root exception (M2)', () => {
  it('documents WHY the worker runtime stays root, so the exception is intentional', () => {
    // Assert the explanatory comment survives — if someone removes it (or the
    // root requirement), this guard forces a conscious decision.
    expect(WORKER).toMatch(/INTENTIONALLY RUNS AS ROOT/i);
    expect(WORKER).toMatch(/kaniko/i);
  });

  it('does not force a non-root USER on the worker (would break kaniko FS snapshotting)', () => {
    expect(WORKER).not.toMatch(/^USER\s+(?!root\b)\S+/m);
  });
});
