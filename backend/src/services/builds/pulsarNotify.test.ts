import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock env + logger so we can flip the feature on/off per test and assert on
// the structured logger without booting the real Zod-validated env.
const h = vi.hoisted(() => ({
  env: { PULSAR_EVENTS_URL: undefined as string | undefined, PULSAR_EVENTS_KEY: undefined as string | undefined },
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../env.js', () => ({ env: h.env }));
vi.mock('../../lib/logger.js', () => ({ logger: h.logger }));

const { emitPulsarDeployEvent, flushPulsarDeployEvents } = await import('./pulsarNotify.js');

const URL = 'https://pulsar.example/ingest-events';
const KEY = 'k'.repeat(32);

function buildRow(over: Record<string, unknown> = {}) {
  return {
    id: 'b1',
    isDemo: false,
    previewId: null,
    commitSha: 'abc1234',
    commitMessage: 'fix: cap batch size',
    branch: 'main',
    project: { name: 'ems' },
    ...over,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  h.env.PULSAR_EVENTS_URL = undefined;
  h.env.PULSAR_EVENTS_KEY = undefined;
  h.logger.warn.mockReset();
  fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('emitPulsarDeployEvent', () => {
  it('no-ops when the feature is unconfigured (either var missing)', async () => {
    h.env.PULSAR_EVENTS_URL = URL; // key still unset
    emitPulsarDeployEvent(buildRow(), 'BUILDING');
    await flushPulsarDeployEvents();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('no-ops for demo builds even when configured', async () => {
    h.env.PULSAR_EVENTS_URL = URL;
    h.env.PULSAR_EVENTS_KEY = KEY;
    emitPulsarDeployEvent(buildRow({ isDemo: true }), 'READY');
    await flushPulsarDeployEvents();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs a lowercased status with bearer auth + structured payload', async () => {
    h.env.PULSAR_EVENTS_URL = URL;
    h.env.PULSAR_EVENTS_KEY = KEY;
    emitPulsarDeployEvent(buildRow(), 'BUILDING');
    await flushPulsarDeployEvents();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(calledUrl).toBe(URL);
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(init.body as string);
    expect(body.event).toMatchObject({
      project: 'ems',
      status: 'building',
      env: 'production',
      deploy_id: 'b1',
      commit_sha: 'abc1234',
      commit_msg: 'fix: cap batch size',
      branch: 'main',
    });
    expect(typeof body.event.ts).toBe('string');
  });

  it('marks preview builds env=preview', async () => {
    h.env.PULSAR_EVENTS_URL = URL;
    h.env.PULSAR_EVENTS_KEY = KEY;
    emitPulsarDeployEvent(buildRow({ previewId: 'pr1' }), 'DEPLOYING');
    await flushPulsarDeployEvents();
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.event.env).toBe('preview');
  });

  it('includes url/duration/error only when provided', async () => {
    h.env.PULSAR_EVENTS_URL = URL;
    h.env.PULSAR_EVENTS_KEY = KEY;
    emitPulsarDeployEvent(buildRow(), 'READY', { url: 'https://live.app', durationMs: 4200 });
    await flushPulsarDeployEvents();
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.event.url).toBe('https://live.app');
    expect(body.event.duration_ms).toBe(4200);
    expect(body.event.error_message).toBeUndefined();
  });

  it('does not throw and logs a warning when the POST rejects', async () => {
    h.env.PULSAR_EVENTS_URL = URL;
    h.env.PULSAR_EVENTS_KEY = KEY;
    fetchMock.mockRejectedValue(new Error('network down'));
    expect(() => emitPulsarDeployEvent(buildRow(), 'FAILED', { errorMessage: 'boom' })).not.toThrow();
    await flushPulsarDeployEvents();
    expect(h.logger.warn).toHaveBeenCalledTimes(1);
  });

  it('logs a warning on a non-2xx response', async () => {
    h.env.PULSAR_EVENTS_URL = URL;
    h.env.PULSAR_EVENTS_KEY = KEY;
    fetchMock.mockResolvedValue({ ok: false, status: 429 });
    emitPulsarDeployEvent(buildRow(), 'BUILDING');
    await flushPulsarDeployEvents();
    expect(h.logger.warn).toHaveBeenCalledTimes(1);
  });
});
