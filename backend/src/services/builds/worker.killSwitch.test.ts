// KILL_SWITCH (and the poll interval) are read from env at module load, so they
// must be set BEFORE importing the worker. A small interval keeps the test fast.
process.env.NODE_ENV = 'test';
process.env.WEB_ORIGIN = 'http://localhost:5173';
process.env.PUBLIC_API_URL = 'http://localhost:3000';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.JWT_SECRET = 'test-jwt-secret-test-jwt-secret-0123456789';
process.env.COOKIE_SECRET = 'test-cookie-secret-0123456789-abcdefghij';
process.env.DATA_ENC_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.GITHUB_OAUTH_CLIENT_ID = 'test-client-id';
process.env.GITHUB_OAUTH_CLIENT_SECRET = 'test-client-secret';
process.env.GITHUB_OAUTH_CALLBACK_URL = 'http://localhost:3000/api/auth/github/callback';
process.env.AZURE_STUB = 'true';
process.env.LOG_LEVEL = 'silent';
// The behaviour under test: when paused, the worker must NOT claim, and must NOT
// exit (exiting tight-loops ACA respawns). kaniko mode is the prod mode and is
// the one that self-aborts after a build — prove that branch is never reached.
process.env.KILL_SWITCH = 'true';
process.env.BUILD_RUNNER_MODE = 'kaniko';
process.env.WORKER_POLL_INTERVAL_MS = '10';

import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  claimNextBuild: vi.fn(),
  recoverOwnClaims: vi.fn(),
  runBuild: vi.fn(),
}));

vi.mock('./queue.js', () => ({
  claimNextBuild: mocks.claimNextBuild,
  recoverOwnClaims: mocks.recoverOwnClaims,
}));
vi.mock('./runBuild.js', () => ({ runBuild: mocks.runBuild }));

const { startWorker } = await import('./worker.js');

describe('worker kill-switch idle behaviour', () => {
  afterEach(() => vi.clearAllMocks());

  it('idles without claiming new builds and without exiting while KILL_SWITCH is set', async () => {
    mocks.recoverOwnClaims.mockResolvedValue(0);
    mocks.claimNextBuild.mockResolvedValue(null);

    const worker = startWorker();
    let exited = false;
    void worker.done.then(() => {
      exited = true;
    });

    // Span many poll intervals (10ms each) — the loop should idle the whole time.
    await new Promise((r) => setTimeout(r, 120));

    // Never claimed (the kill-switch check sits before claimNextBuild) and never
    // ran a build — so the kaniko self-abort branch is never reached.
    expect(mocks.claimNextBuild).not.toHaveBeenCalled();
    expect(mocks.runBuild).not.toHaveBeenCalled();
    // Still alive: the loop did not abort/exit on its own.
    expect(exited).toBe(false);

    // stop() is the ONLY thing that ends the loop in degrade mode.
    await worker.stop();
    expect(exited).toBe(true);
  });
});
