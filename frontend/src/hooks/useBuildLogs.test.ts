import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useBuildLogs } from './useBuildLogs';
import type { LogLine, LogLevel } from '@/types/api';

// The hook talks to the browser's `EventSource` global, which jsdom does not
// provide. We install a fully controllable fake so each test can drive the
// real state machine deterministically — emit named SSE events, flip
// `readyState`, and observe `close()` — with zero network or real timers.

interface Handler {
  (ev: unknown): void;
}

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  /** Every instance ever constructed, newest last — tests grab the latest. */
  static instances: FakeEventSource[] = [];

  readyState = FakeEventSource.OPEN;
  closed = false;
  url: string;
  options: EventSourceInit | undefined;
  private handlers = new Map<string, Set<Handler>>();

  constructor(url: string, options?: EventSourceInit) {
    this.url = url;
    this.options = options;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, handler: Handler): void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler);
  }

  close(): void {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }

  /**
   * Test helper: fire a named SSE event. For 'log'/'status'/'done' the data is
   * JSON-encoded (mirrors the server frames the hook `JSON.parse`s); 'open' and
   * 'error' carry an empty event.
   */
  emit(type: string, dataObject?: unknown): void {
    const set = this.handlers.get(type);
    if (!set) return;
    const event =
      dataObject === undefined ? {} : { data: JSON.stringify(dataObject) };
    for (const handler of set) handler(event);
  }
}

/** Grab the most recently constructed FakeEventSource (the hook's live one). */
function latest(): FakeEventSource {
  const es = FakeEventSource.instances.at(-1);
  if (!es) throw new Error('no EventSource was constructed');
  return es;
}

/** Build a LogLine matching the real `@/types/api` shape. */
function logLine(seq: number, message: string, level: LogLevel = 'INFO'): LogLine {
  return { seq, level, message, ts: '2026-06-13T00:00:00.000Z' };
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  // Some code paths reference the global directly (e.g. `EventSource.CLOSED`).
  (globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('useBuildLogs', () => {
  it('starts in the connecting phase', () => {
    const { result } = renderHook(() => useBuildLogs('build-1'));
    expect(result.current.phase).toBe('connecting');
    expect(result.current.lines).toEqual([]);
    expect(result.current.status).toBeNull();
    // The effect opened exactly one stream against the logs/stream endpoint.
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(latest().url).toContain('/api/builds/build-1/logs/stream');
  });

  it("transitions to 'streaming' on the open event", () => {
    const { result } = renderHook(() => useBuildLogs('build-1'));
    act(() => latest().emit('open'));
    expect(result.current.phase).toBe('streaming');
  });

  it('appends log lines and dedups a repeated seq', () => {
    const { result } = renderHook(() => useBuildLogs('build-1'));

    act(() => {
      latest().emit('log', logLine(1, 'cloning'));
      latest().emit('log', logLine(2, 'building'));
    });
    expect(result.current.lines).toHaveLength(2);
    expect(result.current.lines.map((l) => l.message)).toEqual(['cloning', 'building']);
    expect(result.current.phase).toBe('streaming');

    // Emitting the SAME seq again must NOT add a second line (seenSeq dedup).
    act(() => latest().emit('log', logLine(2, 'building (replayed)')));
    expect(result.current.lines).toHaveLength(2);
    expect(result.current.lines[1]?.message).toBe('building');
  });

  it('reflects the pushed status on a status event', () => {
    const { result } = renderHook(() => useBuildLogs('build-1'));
    act(() => latest().emit('status', { status: 'BUILDING' }));
    expect(result.current.status).toBe('BUILDING');
    act(() => latest().emit('status', { status: 'PUSHING' }));
    expect(result.current.status).toBe('PUSHING');
  });

  it("handles the terminal done event: updates status, phase 'done', closes the stream", () => {
    const { result } = renderHook(() => useBuildLogs('build-1'));
    const es = latest();
    act(() => es.emit('done', { status: 'READY' }));
    expect(result.current.status).toBe('READY');
    expect(result.current.phase).toBe('done');
    expect(es.closed).toBe(true);
    expect(es.readyState).toBe(FakeEventSource.CLOSED);
  });

  it('closes the stream and errors out after the stall timeout with no open/log', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useBuildLogs('build-1'));
    const es = latest();

    expect(result.current.phase).toBe('connecting');
    expect(es.closed).toBe(false);

    // No 'open'/'log' arrives within STALL_TIMEOUT_MS (15000ms).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(es.closed).toBe(true);
    expect(result.current.phase).toBe('error');
  });

  it('errors when the source is CLOSED but stays connecting while still reconnecting', () => {
    const { result } = renderHook(() => useBuildLogs('build-1'));
    const es = latest();

    // Still auto-reconnecting (readyState !== CLOSED) → transient connecting.
    es.readyState = FakeEventSource.CONNECTING;
    act(() => es.emit('error'));
    expect(result.current.phase).toBe('connecting');

    // Source has given up (CLOSED) → hard error.
    es.readyState = FakeEventSource.CLOSED;
    act(() => es.emit('error'));
    expect(result.current.phase).toBe('error');
  });

  it('reconnect() re-opens a fresh stream and returns to connecting', () => {
    const { result } = renderHook(() => useBuildLogs('build-1'));
    const first = latest();

    // Drive into the error phase first.
    first.readyState = FakeEventSource.CLOSED;
    act(() => first.emit('error'));
    expect(result.current.phase).toBe('error');
    expect(FakeEventSource.instances).toHaveLength(1);

    // reconnect() bumps the nonce → effect re-runs → a brand-new EventSource.
    act(() => result.current.reconnect());
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(latest()).not.toBe(first);
    expect(result.current.phase).toBe('connecting');
    expect(result.current.lines).toEqual([]);
  });

  it('opens no stream when buildId is undefined (early return)', () => {
    const { result } = renderHook(() => useBuildLogs(undefined));
    expect(FakeEventSource.instances).toHaveLength(0);
    // Phase stays at its initial value; nothing was wired up.
    expect(result.current.phase).toBe('connecting');
  });
});
