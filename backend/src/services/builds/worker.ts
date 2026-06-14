/**
 * Worker poll loop.
 *
 * Single-concurrency by design (`maxReplicas=1` on prodstack-builder per
 * the operational policy): grab one job, run it to completion,
 * grab the next. No internal parallelism, no per-build child processes for
 * the orchestration code — only the kaniko/git spawns actually escape the
 * Node process.
 *
 * Mounted on the API process in dev (ENABLE_WORKER=true) and as the sole
 * entrypoint in the prodstack-builder image (`backend/dist/worker.js`).
 */
import { env } from '../../env.js';
import { logger } from '../../lib/logger.js';
import { claimNextBuild, failExhaustedBuilds, recoverOwnClaims } from './queue.js';
import { runBuild } from './runBuild.js';

export interface WorkerHandle {
  stop: () => Promise<void>;
  /** Resolves when the poll loop exits — via stop() or single-use self-abort. */
  done: Promise<void>;
}

/**
 * Start the loop. Returns a handle whose `stop()` resolves once the
 * currently-running build (if any) finishes. Idle ticks are interruptible
 * immediately via the AbortController.
 */
export function startWorker(): WorkerHandle {
  const controller = new AbortController();
  const log = logger.child({ component: 'worker', workerId: env.WORKER_ID });

  log.info(
    {
      mode: env.BUILD_RUNNER_MODE,
      pollMs: env.WORKER_POLL_INTERVAL_MS,
      timeoutMs: env.BUILD_TIMEOUT_MS,
    },
    'worker starting',
  );

  const loop = (async () => {
    try {
      // Headroom: a healthy build is bounded by BUILD_TIMEOUT_MS; anything
      // older than 2× that with no progress is a dead worker, not a slow one.
      const staleAfterMs = env.BUILD_TIMEOUT_MS * 2;
      const recovered = await recoverOwnClaims(env.WORKER_ID, staleAfterMs);
      if (recovered > 0) {
        log.info({ recovered }, 'released stale claims from previous run');
      }
    } catch (err) {
      log.error({ err }, 'claim recovery failed');
    }

    let killSwitchLogged = false;
    while (!controller.signal.aborted) {
      // Kill switch (degrade mode): stop claiming NEW builds while the platform
      // is paused for cost reasons. We deliberately keep the replica alive and
      // idle rather than exiting — exiting would make ACA respawn it in a tight
      // restart loop, the opposite of what a cost kill switch wants. Any build
      // already claimed before the switch flipped on finishes naturally (the
      // switch is read at boot, so in practice the loop simply never starts a
      // new claim once it's set).
      if (env.KILL_SWITCH) {
        if (!killSwitchLogged) {
          log.warn('kill switch active — worker idling, not claiming new builds');
          killSwitchLogged = true;
        }
        await sleepInterruptible(env.WORKER_POLL_INTERVAL_MS, controller.signal);
        continue;
      }

      let claimed: Awaited<ReturnType<typeof claimNextBuild>> = null;
      try {
        // Drain poison pills first: a build that has burned through its claim
        // budget (kept crashing the worker) is failed here so it stops being
        // re-claimed AND stops keeping the KEDA `builds-pending` count > 0.
        const reaped = await failExhaustedBuilds(env.BUILD_MAX_ATTEMPTS);
        if (reaped > 0) {
          log.warn({ reaped }, 'failed builds that exhausted their attempt budget');
        }
        claimed = await claimNextBuild(env.WORKER_ID, env.BUILD_MAX_ATTEMPTS);
      } catch (err) {
        log.error({ err }, 'queue poll failed');
      }

      if (claimed === null) {
        await sleepInterruptible(env.WORKER_POLL_INTERVAL_MS, controller.signal);
        continue;
      }

      log.info({ buildId: claimed.id, attempts: claimed.attempts }, 'claimed build');
      try {
        await runBuild(claimed.id);
      } catch (err) {
        // runBuild handles its own DB state on failure; this is a safety
        // backstop so the loop survives unexpected throws.
        log.error({ err, buildId: claimed.id }, 'runBuild threw past its own handler');
      }

      // Single-use mode: kaniko's stage-transition `DeleteFilesystem` wipes
      // the worker container's `/` (git, node_modules, /usr/bin/…) between
      // stages of a multi-stage Dockerfile. The current build still finishes
      // because the Node process is already in memory, but any subsequent
      // build in the same container fails at `spawn git ENOENT`. Aborting
      // the loop drops us back to the entrypoint, which exits the process;
      // ACA respawns the Container App replica with a fresh filesystem.
      if (env.BUILD_RUNNER_MODE === 'kaniko') {
        log.info(
          { buildId: claimed.id },
          'kaniko leaves the worker fs unusable — exiting so ACA respawns the replica',
        );
        controller.abort();
      }
    }

    log.info('worker stopped');
  })();

  return {
    stop: async () => {
      controller.abort();
      await loop;
    },
    done: loop,
  };
}

function sleepInterruptible(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
