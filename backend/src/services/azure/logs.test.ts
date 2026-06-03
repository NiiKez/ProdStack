process.env.NODE_ENV = 'test';
process.env.DATA_ENC_KEY ??= Buffer.alloc(32, 9).toString('base64');
process.env.JWT_SECRET ??= 'x'.repeat(40);
process.env.COOKIE_SECRET ??= 'y'.repeat(40);
process.env.WEB_ORIGIN ??= 'http://localhost:5173';
process.env.GITHUB_OAUTH_CLIENT_ID ??= 'cid';
process.env.GITHUB_OAUTH_CLIENT_SECRET ??= 'csecret';
process.env.GITHUB_OAUTH_CALLBACK_URL ??= 'http://localhost:3000/api/auth/github/callback';
process.env.DATABASE_URL ??= 'postgresql://test/test';
process.env.LOG_LEVEL ??= 'silent';
process.env.AZURE_SUBSCRIPTION_ID ??= 'sub-test';
process.env.AZURE_RESOURCE_GROUP ??= 'prodstack';
process.env.AZURE_REGION ??= 'francecentral';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  queryWorkspace: vi.fn(),
  LogsQueryClient: vi.fn(),
  DefaultAzureCredential: vi.fn(),
}));

vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: mocks.DefaultAzureCredential,
}));

// Mock the SDK but keep the real `Durations`/`LogsQueryResultStatus` values so
// the module under test compares against the genuine enum.
vi.mock('@azure/monitor-query', async () => {
  const actual = await vi.importActual<typeof import('@azure/monitor-query')>(
    '@azure/monitor-query',
  );
  return {
    ...actual,
    LogsQueryClient: mocks.LogsQueryClient,
  };
});

beforeEach(() => {
  vi.resetModules();
  mocks.queryWorkspace.mockReset();
  mocks.LogsQueryClient.mockReset();
  mocks.DefaultAzureCredential.mockReset();

  mocks.DefaultAzureCredential.mockImplementation(() => ({ kind: 'default-cred' }));
  mocks.LogsQueryClient.mockImplementation(() => ({
    queryWorkspace: mocks.queryWorkspace,
  }));

  delete process.env.LOG_ANALYTICS_WORKSPACE_ID;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('queryRuntimeLogs (stub branch)', () => {
  beforeEach(() => {
    process.env.AZURE_STUB = 'true';
  });

  it('returns deterministic fake lines with correct shapes', async () => {
    const { queryRuntimeLogs } = await import('./logs.js');
    const result = await queryRuntimeLogs({ containerAppName: 'demo' });

    expect(result.available).toBe(true);
    expect(result.lines.length).toBeGreaterThan(0);

    for (const line of result.lines) {
      expect(typeof line.ts).toBe('string');
      expect(typeof line.message).toBe('string');
      expect(['stdout', 'stderr', 'unknown']).toContain(line.stream);
      expect(line.revision === null || typeof line.revision === 'string').toBe(true);
    }

    // ascending ts
    const ts = result.lines.map((l) => l.ts);
    expect([...ts].sort()).toEqual(ts);

    // Never touches the SDK in stub mode.
    expect(mocks.LogsQueryClient).not.toHaveBeenCalled();
    expect(mocks.queryWorkspace).not.toHaveBeenCalled();
  });

  it('returns empty (but available) when afterTs is provided', async () => {
    const { queryRuntimeLogs } = await import('./logs.js');
    const result = await queryRuntimeLogs({
      containerAppName: 'demo',
      afterTs: new Date().toISOString(),
    });

    expect(result.available).toBe(true);
    expect(result.lines).toEqual([]);
  });
});

describe('queryRuntimeLogs (real branch, no workspace id)', () => {
  beforeEach(() => {
    process.env.AZURE_STUB = 'false';
    delete process.env.LOG_ANALYTICS_WORKSPACE_ID;
  });

  it('reports unavailable with a note and never constructs the client', async () => {
    const { queryRuntimeLogs } = await import('./logs.js');
    const result = await queryRuntimeLogs({ containerAppName: 'demo' });

    expect(result.available).toBe(false);
    expect(result.lines).toEqual([]);
    expect(result.note).toBeTruthy();

    expect(mocks.LogsQueryClient).not.toHaveBeenCalled();
    expect(mocks.queryWorkspace).not.toHaveBeenCalled();
  });
});

describe('queryRuntimeLogs (real branch, with workspace id)', () => {
  beforeEach(() => {
    process.env.AZURE_STUB = 'false';
    process.env.LOG_ANALYTICS_WORKSPACE_ID = 'ws-guid-123';
  });

  it('maps a canned 2-row table and queries the right workspace', async () => {
    const { LogsQueryResultStatus } = await import('@azure/monitor-query');

    const t1 = new Date('2026-06-03T10:00:00.000Z');
    const t2 = new Date('2026-06-03T10:00:01.000Z');

    mocks.queryWorkspace.mockResolvedValue({
      status: LogsQueryResultStatus.Success,
      tables: [
        {
          name: 'PrimaryResult',
          columnDescriptors: [
            { name: 'TimeGenerated', type: 'datetime' },
            { name: 'Log_s', type: 'string' },
            { name: 'Stream_s', type: 'string' },
            { name: 'RevisionName_s', type: 'string' },
          ],
          rows: [
            [t1, 'Server listening on :3000', 'stdout', 'demo--abc'],
            [t2, 'boom: something failed', 'stderr', 'demo--abc'],
          ],
        },
      ],
    });

    const { queryRuntimeLogs } = await import('./logs.js');
    const result = await queryRuntimeLogs({ containerAppName: 'demo' });

    expect(result.available).toBe(true);
    expect(result.lines).toEqual([
      {
        ts: t1.toISOString(),
        message: 'Server listening on :3000',
        stream: 'stdout',
        revision: 'demo--abc',
      },
      {
        ts: t2.toISOString(),
        message: 'boom: something failed',
        stream: 'stderr',
        revision: 'demo--abc',
      },
    ]);

    expect(mocks.LogsQueryClient).toHaveBeenCalledTimes(1);
    expect(mocks.queryWorkspace).toHaveBeenCalledTimes(1);
    const [workspaceId, query] = mocks.queryWorkspace.mock.calls[0]!;
    expect(workspaceId).toBe('ws-guid-123');
    expect(query).toContain('ContainerAppConsoleLogs_CL');
    expect(query).toContain('ContainerAppName_s == "demo"');
  });

  it('degrades gracefully (available:false + note) on a query error', async () => {
    mocks.queryWorkspace.mockRejectedValue(new Error('network blip'));

    const { queryRuntimeLogs } = await import('./logs.js');
    const result = await queryRuntimeLogs({ containerAppName: 'demo' });

    expect(result.available).toBe(false);
    expect(result.lines).toEqual([]);
    expect(result.note).toBeTruthy();
  });
});
