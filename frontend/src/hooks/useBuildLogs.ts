import { useCallback, useEffect, useRef, useState } from 'react';
import { env } from '@/env';
import type { LogLine } from '@/types/api';

export type StreamPhase = 'connecting' | 'streaming' | 'done' | 'error';

export interface UseBuildLogsResult {
  lines: LogLine[];
  /** Latest build status pushed over the stream (UPPERCASE enum), or null. */
  status: string | null;
  phase: StreamPhase;
  /** Tear down + re-open the stream from scratch (manual recovery on error). */
  reconnect: () => void;
}

/**
 * Subscribe to `GET /api/builds/:id/logs/stream` via `EventSource`.
 *
 * EventSource can't set headers, but it sends cookies automatically — in dev
 * the Vite proxy keeps `/api` same-origin so the session cookie rides along.
 * `withCredentials` is set for the future cross-subdomain prod story (needs
 * `SameSite=None; Secure` + CORS — deferred).
 *
 * Reconnection is automatic: the server stamps each `log` event with
 * `id: <seq>`, so the browser replays `Last-Event-ID` on reconnect and the
 * server resumes strictly after the last delivered line — no duplicates, no
 * gaps. We close on the terminal `done` event to stop the reconnect loop.
 */
export function useBuildLogs(buildId: string | undefined): UseBuildLogsResult {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [phase, setPhase] = useState<StreamPhase>('connecting');
  // Guard against duplicate seqs across reconnects (defensive — server already
  // dedupes via Last-Event-ID, but a racing replay shouldn't double-render).
  const seenSeq = useRef<Set<number>>(new Set());
  // Bumped by `reconnect()` to re-run the effect and re-open a closed stream.
  const [nonce, setNonce] = useState(0);
  const reconnect = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!buildId) return;

    seenSeq.current = new Set();
    setLines([]);
    setStatus(null);
    setPhase('connecting');

    const url = `${env.apiBaseUrl || ''}/api/builds/${buildId}/logs/stream`;
    const es = new EventSource(url, { withCredentials: true });

    es.addEventListener('open', () => setPhase('streaming'));

    es.addEventListener('log', (ev) => {
      try {
        const line = JSON.parse((ev as MessageEvent).data) as LogLine;
        if (seenSeq.current.has(line.seq)) return;
        seenSeq.current.add(line.seq);
        setLines((prev) => [...prev, line]);
        setPhase('streaming');
      } catch {
        // ignore malformed frame
      }
    });

    es.addEventListener('status', (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as { status: string };
        setStatus(data.status);
      } catch {
        // ignore
      }
    });

    es.addEventListener('done', (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as { status: string };
        setStatus(data.status);
      } catch {
        // ignore
      }
      setPhase('done');
      es.close();
    });

    es.addEventListener('error', () => {
      // EventSource auto-reconnects unless we've already closed it. Surface a
      // transient "connecting" state; only mark hard error if it's closed.
      if (es.readyState === EventSource.CLOSED) {
        setPhase((p) => (p === 'done' ? p : 'error'));
      } else {
        setPhase('connecting');
      }
    });

    return () => es.close();
  }, [buildId, nonce]);

  return { lines, status, phase, reconnect };
}
