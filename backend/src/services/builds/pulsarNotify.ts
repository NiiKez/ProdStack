/**
 * Fire-and-forget push of build/deploy status transitions to the Pulsar
 * dashboard's `ingest-events` endpoint (Phase 3 of Pulsar's app-log plan).
 *
 * ProdStack is the only emitter of its own build/deploy lifecycle — a deployed
 * app can't report its own deploy, only the PaaS knows it. So on every status
 * transition the worker POSTs a structured event and Pulsar renders a deploy
 * timeline. This is intentionally best-effort: a Pulsar outage must never fail
 * or slow a build. BOTH `PULSAR_EVENTS_URL` and `PULSAR_EVENTS_KEY` must be set
 * or the feature is off (no outbound calls) — byte-identical prior behavior.
 *
 * Delivery mirrors {@link LogSink}: `emitPulsarDeployEvent()` fires immediately
 * (non-blocking) and tracks the in-flight POST; `flushPulsarDeployEvents()`
 * (awaited in runBuild's `finally`) drains them so a single-use worker doesn't
 * exit mid-POST and silently drop the terminal READY/FAILED event.
 *
 * Pulsar dedupes on `(source, deploy_id + ':' + mappedStatus)`, and its status
 * map collapses cloning/building/pushing → "building", so emitting on every
 * transition yields a clean building → deploying → ready/failed timeline with no
 * duplicate rows.
 */
import { env } from '../../env.js';
import { logger } from '../../lib/logger.js';

/** Hard timeout on the outbound POST — a hung Pulsar can't stall a build. */
const POST_TIMEOUT_MS = 4000;

/** The subset of a Build (with its project) the event payload reads. */
export interface DeployEventBuild {
  id: string;
  isDemo: boolean;
  previewId: string | null;
  commitSha: string;
  commitMessage: string;
  branch: string;
  project: { name: string };
}

export interface DeployEventExtra {
  /** Deployed URL — only known once the app is live (READY). */
  url?: string | null;
  /** Build/deploy duration in ms — only known at READY. */
  durationMs?: number | null;
  /** Failure reason — set on FAILED. */
  errorMessage?: string | null;
}

/** In-flight POSTs, drained by {@link flushPulsarDeployEvents}. */
const inflight = new Set<Promise<void>>();

/**
 * Fire a deploy event (non-blocking). No-ops when the feature is unconfigured
 * or the build is a demo replay (demo lifecycle must never reach the dashboard).
 * Never throws — a transport error is logged to the structured logger, not the
 * caller.
 */
export function emitPulsarDeployEvent(
  build: DeployEventBuild,
  status: string,
  extra: DeployEventExtra = {},
): void {
  const url = env.PULSAR_EVENTS_URL;
  const key = env.PULSAR_EVENTS_KEY;
  if (!url || !key) return; // feature off — both required
  if (build.isDemo) return; // demo builds never notify the real dashboard

  const p = postEvent(url, key, build, status, extra)
    .catch((err: unknown) => {
      logger.warn({ err, buildId: build.id, deployStatus: status }, 'pulsar deploy-event POST failed');
    })
    .finally(() => {
      inflight.delete(p);
    });
  inflight.add(p);
}

/** Await all in-flight deploy-event POSTs (called from runBuild's `finally`). */
export async function flushPulsarDeployEvents(): Promise<void> {
  await Promise.allSettled(inflight);
}

async function postEvent(
  url: string,
  key: string,
  build: DeployEventBuild,
  status: string,
  extra: DeployEventExtra,
): Promise<void> {
  const event = {
    project: build.project.name,
    status: status.toLowerCase(),
    env: build.previewId ? 'preview' : 'production',
    deploy_id: build.id,
    commit_sha: build.commitSha,
    commit_msg: build.commitMessage,
    branch: build.branch,
    ts: new Date().toISOString(),
    ...(extra.url ? { url: extra.url } : {}),
    ...(typeof extra.durationMs === 'number' ? { duration_ms: extra.durationMs } : {}),
    ...(extra.errorMessage ? { error_message: extra.errorMessage } : {}),
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ event }),
    signal: AbortSignal.timeout(POST_TIMEOUT_MS),
  });

  if (!res.ok) {
    logger.warn(
      { statusCode: res.status, buildId: build.id, deployStatus: status },
      'pulsar deploy-event POST returned non-2xx',
    );
  }
}
