// Git-phase timeout (review finding HIGH #1: "git clone/fetch/checkout has no
// timeout — wedges the entire build queue"). A git server that accepts the TCP
// connection then stalls would otherwise hang the single-replica worker forever
// (the cooperative-cancel path only fires on a *user* cancel). `spawnLogged` now
// takes a hard `timeoutMs` that SIGKILLs the child and rejects with a distinct
// "timed out" error, mirroring the kaniko wrapper.
//
// These exercise the real spawn path against actual child processes (no mocked
// child_process), so the SIGKILL + close-handler wiring is covered end-to-end.
import { describe, expect, it } from 'vitest';

import { spawnLogged } from './runBuild.js';

/** A node child that never exits on its own — only a kill terminates it. */
const HANGS_FOREVER = ['-e', 'setInterval(() => {}, 1000)'];

describe('spawnLogged — hard timeout (git-phase wedge guard)', () => {
  it('SIGKILLs a child that outruns timeoutMs and rejects with a "timed out" error', async () => {
    const start = Date.now();
    await expect(
      spawnLogged(process.execPath, HANGS_FOREVER, {
        onLine: () => {},
        redact: [],
        timeoutMs: 200,
      }),
    ).rejects.toThrow(/timed out after 200ms/);
    // The whole point: the promise settles promptly because the child was
    // killed — it does NOT wait out the (infinite) child. A few seconds of
    // headroom keeps this non-flaky on a loaded CI box without ever
    // approaching the child's never-ending runtime.
    expect(Date.now() - start).toBeLessThan(3000);
  });

  it('distinguishes a timeout from a non-zero exit (does not mask real failures)', async () => {
    // A child that exits 3 well before the deadline must reject with the exit
    // code, not "timed out" — the timedOut flag must only fire on the timer.
    await expect(
      spawnLogged(process.execPath, ['-e', 'process.exit(3)'], {
        onLine: () => {},
        redact: [],
        timeoutMs: 5000,
      }),
    ).rejects.toThrow(/exited with code 3/);
  });

  it('resolves normally when the child finishes before the deadline', async () => {
    await expect(
      spawnLogged(process.execPath, ['-e', 'process.exit(0)'], {
        onLine: () => {},
        redact: [],
        timeoutMs: 5000,
      }),
    ).resolves.toBeUndefined();
  });

  it('does not arm a timeout when timeoutMs is omitted (backward compatible)', async () => {
    // No timer → a quick child still resolves; this guards the `=== undefined`
    // branch so an omitted timeout can never accidentally kill a real build.
    await expect(
      spawnLogged(process.execPath, ['-e', 'process.exit(0)'], {
        onLine: () => {},
        redact: [],
      }),
    ).resolves.toBeUndefined();
  });

  it('redacts secrets from the killed child output path too', async () => {
    // Even on the timeout path the line streamer redacts — assert a secret
    // emitted right before the kill never reaches onLine in the clear.
    const lines: string[] = [];
    const secret = 'ghu_supersecrettoken';
    await expect(
      spawnLogged(
        process.execPath,
        ['-e', `console.log('using ${secret}'); setInterval(() => {}, 1000)`],
        {
          onLine: (l) => lines.push(l),
          redact: [secret],
          timeoutMs: 400,
        },
      ),
    ).rejects.toThrow(/timed out/);
    const joined = lines.join('\n');
    expect(joined).not.toContain(secret);
    expect(joined).toContain('***');
  });
});
