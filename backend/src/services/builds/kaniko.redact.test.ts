// Finding 1 (HIGH) — the kaniko output path must redact secrets, exactly like
// the git path does. The git phase strips secrets inside `spawnLogged`
// (runBuild.ts) before any line reaches `onLine`; before this fix the kaniko
// phase (`streamLines` in kaniko.ts) wrote raw stdout/stderr straight through.
// runKaniko now takes a `redactSecrets` set and applies the shared `redact`
// helper to BOTH the assembled-line path and the trailing tail/truncation path.
//
// This suite runs the REAL runKaniko → spawnAndStream → streamLines → redact
// code against a FAKE child process (node:child_process `spawn` mocked), so the
// secret values that flow through are asserted to be `***` in what reaches
// `onLine` (the same boundary that feeds the persisted LogLine + the live SSE
// stream). Mirrors how runBuild.timeout.test.ts proves redaction on the killed
// git-child path.
//
// env is validated once at import, and runKaniko needs BUILD_RUNNER_MODE=kaniko
// plus ACR creds (writeDockerConfig reads them), so we freeze them via
// vi.hoisted before the dynamic import — same pattern as kaniko.dockerhub.test.ts.
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ACR_PASSWORD = 'super-secret-acr-pw-9f2c';
const DOCKERHUB_TOKEN = 'dckr_pat_FAKE_TOKEN_abc123';
const GITHUB_TOKEN = 'ghp_FAKE_github_token_4242';

vi.hoisted(() => {
  process.env.ACR_NAME = 'testacr';
  process.env.ACR_USERNAME = 'acruser';
  process.env.ACR_PASSWORD = 'super-secret-acr-pw-9f2c';
  process.env.DOCKERHUB_USERNAME = 'hubuser';
  process.env.DOCKERHUB_TOKEN = 'dckr_pat_FAKE_TOKEN_abc123';
  // The crux: non-stub mode so runKaniko actually spawns + streams (it throws on
  // BUILD_RUNNER_MODE=stub). The spawned binary is mocked away below.
  process.env.BUILD_RUNNER_MODE = 'kaniko';
});

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));

// Mock only `spawn`; keep the rest of node:child_process intact.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: mocks.spawn };
});

const { runKaniko } = await import('./kaniko.js');

/**
 * A stdout/stderr stand-in. kaniko's `streamLines` calls `setEncoding('utf8')`
 * then `.on('data')` / `.on('end')`, so a bare EventEmitter needs a no-op
 * `setEncoding` to satisfy the contract.
 */
class FakeStream extends EventEmitter {
  setEncoding(): this {
    return this;
  }
}

interface FakeChild extends EventEmitter {
  stdout: FakeStream;
  stderr: FakeStream;
  kill: () => void;
}

/**
 * A fake kaniko child. `emit` is called on the next tick (so the listeners
 * spawnAndStream/streamLines register synchronously are attached first) with
 * `{ stdout, stderr }` chunk arrays, then both streams `end` and the process
 * `close`s 0. Chunks are emitted verbatim — pass a chunk WITHOUT a trailing
 * newline to drive the tail/truncation path, or split a secret across two
 * chunks to drive the assembled-line (cross-chunk buffer) path.
 */
function fakeKanikoChild(chunks: { stdout?: string[]; stderr?: string[] }): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new FakeStream();
  child.stderr = new FakeStream();
  child.kill = vi.fn();
  setImmediate(() => {
    for (const c of chunks.stdout ?? []) child.stdout.emit('data', c);
    for (const c of chunks.stderr ?? []) child.stderr.emit('data', c);
    child.stdout.emit('end');
    child.stderr.emit('end');
    child.emit('close', 0);
  });
  return child;
}

let contextDir: string;
let authDir: string;
const collected: { line: string; stream: 'stdout' | 'stderr' }[] = [];

beforeEach(async () => {
  mocks.spawn.mockReset();
  collected.length = 0;
  // writeDockerConfig writes <authDir>/.docker/config.json for real; authDir
  // must be a SIBLING of contextDir (assertAuthDirIsolated), so use two temps.
  contextDir = await mkdtemp(path.join(os.tmpdir(), 'kaniko-redact-ctx-'));
  authDir = await mkdtemp(path.join(os.tmpdir(), 'kaniko-redact-auth-'));
});

afterEach(async () => {
  if (contextDir) await rm(contextDir, { recursive: true, force: true });
  if (authDir) await rm(authDir, { recursive: true, force: true });
});

function run(redactSecrets: string[]): Promise<{ exitCode: number; timedOut: boolean }> {
  return runKaniko({
    contextDir,
    authDir,
    dockerfile: path.join(contextDir, 'Dockerfile'),
    destinations: ['testacr.azurecr.io/app:sha'],
    timeoutMs: 5000,
    redactSecrets,
    onLine: (line, stream) => collected.push({ line, stream }),
  });
}

describe('runKaniko — secret redaction (Finding 1)', () => {
  it('redacts a secret echoed on a complete stdout line before it reaches onLine', async () => {
    mocks.spawn.mockImplementation(() =>
      fakeKanikoChild({
        stdout: [
          `error pushing image: registry auth failed with password ${ACR_PASSWORD}\n`,
        ],
      }),
    );

    const result = await run([ACR_PASSWORD, DOCKERHUB_TOKEN]);
    expect(result.exitCode).toBe(0);

    const all = collected.map((c) => c.line).join('\n');
    // The raw secret must NEVER appear in what's emitted to the LogSink.
    expect(all).not.toContain(ACR_PASSWORD);
    expect(all).toContain('***');
    // The non-secret remainder of the line survives.
    expect(all).toContain('error pushing image: registry auth failed with password');
  });

  it('redacts a secret split across two data chunks (assembled-line path)', async () => {
    // The secret straddles the chunk boundary; streamLines must buffer, then
    // redact the ASSEMBLED line — not each raw chunk.
    const head = ACR_PASSWORD.slice(0, 8);
    const tail = ACR_PASSWORD.slice(8);
    mocks.spawn.mockImplementation(() =>
      fakeKanikoChild({ stdout: [`pushing layer ${head}`, `${tail} rejected\n`] }),
    );

    await run([ACR_PASSWORD]);

    const all = collected.map((c) => c.line).join('\n');
    expect(all).not.toContain(ACR_PASSWORD);
    expect(all).toContain('pushing layer ***');
  });

  it('redacts a secret on the trailing tail/truncation path (no final newline)', async () => {
    // No trailing newline → the line is flushed by streamLines' `end` handler,
    // which must redact too (not just the per-line `data` handler).
    mocks.spawn.mockImplementation(() =>
      fakeKanikoChild({
        stderr: [`fatal: docker hub pull denied for token ${DOCKERHUB_TOKEN}`],
      }),
    );

    await run([ACR_PASSWORD, DOCKERHUB_TOKEN]);

    const tailLines = collected.filter((c) => c.stream === 'stderr');
    expect(tailLines.length).toBeGreaterThan(0);
    const all = tailLines.map((c) => c.line).join('\n');
    expect(all).not.toContain(DOCKERHUB_TOKEN);
    expect(all).toContain('***');
  });

  it('strips every secret in the set (ACR password, Docker Hub token, GitHub token)', async () => {
    mocks.spawn.mockImplementation(() =>
      fakeKanikoChild({
        stdout: [
          `acr=${ACR_PASSWORD} hub=${DOCKERHUB_TOKEN} gh=${GITHUB_TOKEN}\n`,
        ],
      }),
    );

    await run([ACR_PASSWORD, DOCKERHUB_TOKEN, GITHUB_TOKEN]);

    const all = collected.map((c) => c.line).join('\n');
    expect(all).not.toContain(ACR_PASSWORD);
    expect(all).not.toContain(DOCKERHUB_TOKEN);
    expect(all).not.toContain(GITHUB_TOKEN);
    expect(all).toBe('acr=*** hub=*** gh=***');
  });

  it('passes non-secret lines through unchanged (no over-redaction)', async () => {
    mocks.spawn.mockImplementation(() =>
      fakeKanikoChild({ stdout: ['INFO Taking snapshot of full filesystem...\n'] }),
    );

    await run([ACR_PASSWORD, DOCKERHUB_TOKEN]);

    const all = collected.map((c) => c.line).join('\n');
    expect(all).toBe('INFO Taking snapshot of full filesystem...');
  });
});
