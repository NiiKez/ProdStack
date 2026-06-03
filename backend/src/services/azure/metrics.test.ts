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
process.env.AZURE_SUBSCRIPTION_ID = 'sub-test';
process.env.AZURE_RESOURCE_GROUP = 'prodstack';
process.env.AZURE_REGION = 'francecentral';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MetricKey } from './metrics.js';

const mocks = vi.hoisted(() => ({
  queryResource: vi.fn(),
  DefaultAzureCredential: vi.fn(),
  MetricsQueryClient: vi.fn(),
}));

vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: mocks.DefaultAzureCredential,
}));

vi.mock('@azure/monitor-query', () => ({
  MetricsQueryClient: mocks.MetricsQueryClient,
}));

beforeEach(() => {
  vi.resetModules();
  mocks.queryResource.mockReset();
  mocks.DefaultAzureCredential.mockReset();
  mocks.MetricsQueryClient.mockReset();

  mocks.DefaultAzureCredential.mockImplementation(() => ({ kind: 'default-cred' }));
  mocks.MetricsQueryClient.mockImplementation(() => ({
    queryResource: mocks.queryResource,
  }));
});

afterEach(() => {
  delete process.env.AZURE_STUB;
});

const EXPECTED_KEYS: MetricKey[] = ['cpu', 'memory', 'replicas', 'requests'];

describe('getAppMetrics (stub branch)', () => {
  beforeEach(() => {
    process.env.AZURE_STUB = 'true';
  });

  it('returns all four series with correct keys, units, and interval for a 6h range', async () => {
    const { getAppMetrics } = await import('./metrics.js');
    const result = await getAppMetrics({ containerAppName: 'x', range: '6h' });

    expect(result.range).toBe('6h');
    expect(result.intervalMinutes).toBe(15);
    expect(result.series.map((s) => s.key)).toEqual(EXPECTED_KEYS);

    const byKey = Object.fromEntries(result.series.map((s) => [s.key, s]));
    expect(byKey.cpu!.unit).toBe('cores');
    expect(byKey.memory!.unit).toBe('MiB');
    expect(byKey.replicas!.unit).toBe('');
    expect(byKey.requests!.unit).toBe('req');

    // Every series has points, each well-formed.
    for (const series of result.series) {
      expect(series.points.length).toBeGreaterThan(0);
      for (const point of series.points) {
        expect(typeof point.t).toBe('string');
        expect(!Number.isNaN(Date.parse(point.t))).toBe(true);
        expect(point.v === null || typeof point.v === 'number').toBe(true);
      }
    }

    // No real Azure client is constructed in stub mode.
    expect(mocks.MetricsQueryClient).not.toHaveBeenCalled();
  });

  it('maps each range to the documented interval (1h→5, 24h→60)', async () => {
    const { getAppMetrics } = await import('./metrics.js');

    const oneHour = await getAppMetrics({ containerAppName: 'x', range: '1h' });
    expect(oneHour.intervalMinutes).toBe(5);

    const dayResult = await getAppMetrics({ containerAppName: 'x', range: '24h' });
    expect(dayResult.intervalMinutes).toBe(60);
  });

  it('defaults to the 1h range when none is given', async () => {
    const { getAppMetrics } = await import('./metrics.js');
    const result = await getAppMetrics({ containerAppName: 'x' });
    expect(result.range).toBe('1h');
    expect(result.intervalMinutes).toBe(5);
  });
});

describe('getAppMetrics (real branch)', () => {
  beforeEach(() => {
    process.env.AZURE_STUB = 'false';
  });

  it('builds the resource URI and maps datapoints (value converted; missing → null)', async () => {
    // Canned result: one timeseries, two data points — the first carries a
    // value, the second omits the aggregation field (no data in that bucket).
    // We return the same shape for every metric; the resource URI assertion and
    // the cpu (nanocores→cores) conversion are what we verify.
    mocks.queryResource.mockImplementation(
      (_uri: string, metricNames: string[]) => {
        const name = metricNames[0]!;
        return Promise.resolve({
          metrics: [
            {
              name,
              timeseries: [
                {
                  data: [
                    {
                      timeStamp: new Date('2026-06-03T10:00:00.000Z'),
                      average: 250_000_000, // 0.25 cores after /1e9
                      maximum: 1,
                      total: 5,
                    },
                    {
                      timeStamp: new Date('2026-06-03T10:05:00.000Z'),
                      // no average/maximum/total → null
                    },
                  ],
                },
              ],
            },
          ],
        });
      },
    );

    const { getAppMetrics } = await import('./metrics.js');
    const result = await getAppMetrics({ containerAppName: 'demo-app', range: '1h' });

    // The client was built with DefaultAzureCredential.
    expect(mocks.DefaultAzureCredential).toHaveBeenCalled();
    expect(mocks.MetricsQueryClient).toHaveBeenCalledWith({ kind: 'default-cred' });

    // One query per metric (4), each against the expected resource URI.
    expect(mocks.queryResource).toHaveBeenCalledTimes(4);
    const EXPECTED_URI =
      '/subscriptions/sub-test/resourceGroups/prodstack/providers/Microsoft.App/containerApps/demo-app';
    for (const call of mocks.queryResource.mock.calls) {
      expect(call[0]).toBe(EXPECTED_URI);
    }

    // The cpu query asked for UsageNanoCores + Average over PT5M / PT1H.
    const cpuCall = mocks.queryResource.mock.calls.find(
      (c) => (c[1] as string[])[0] === 'UsageNanoCores',
    );
    expect(cpuCall).toBeDefined();
    expect(cpuCall![1]).toEqual(['UsageNanoCores']);
    expect(cpuCall![2]).toMatchObject({
      granularity: 'PT5M',
      timespan: { duration: 'PT1H' },
      aggregations: ['Average'],
    });

    const byKey = Object.fromEntries(result.series.map((s) => [s.key, s]));
    // cpu: 250_000_000 nanocores → 0.25 cores; second bucket → null.
    expect(byKey.cpu!.points).toEqual([
      { t: '2026-06-03T10:00:00.000Z', v: 0.25 },
      { t: '2026-06-03T10:05:00.000Z', v: null },
    ]);
    // requests uses Total (5); replicas uses Maximum (1).
    expect(byKey.requests!.points[0]!.v).toBe(5);
    expect(byKey.replicas!.points[0]!.v).toBe(1);
    // second bucket always null (field missing).
    expect(byKey.requests!.points[1]!.v).toBeNull();
  });

  it('degrades a single failing metric to an empty-points series instead of throwing', async () => {
    mocks.queryResource.mockImplementation((_uri: string, metricNames: string[]) => {
      if (metricNames[0] === 'Requests') {
        return Promise.reject(new Error('metric not found'));
      }
      return Promise.resolve({
        metrics: [
          {
            name: metricNames[0],
            timeseries: [
              {
                data: [{ timeStamp: new Date('2026-06-03T10:00:00.000Z'), average: 1e9, maximum: 1, total: 2 }],
              },
            ],
          },
        ],
      });
    });

    const { getAppMetrics } = await import('./metrics.js');
    const result = await getAppMetrics({ containerAppName: 'demo-app', range: '6h' });

    const byKey = Object.fromEntries(result.series.map((s) => [s.key, s]));
    // Failing metric → empty points, but the series still exists.
    expect(byKey.requests!.points).toEqual([]);
    // The others still mapped fine.
    expect(byKey.cpu!.points[0]!.v).toBe(1); // 1e9 nanocores → 1 core
  });

  it('throws a useful error when AZURE_SUBSCRIPTION_ID is missing', async () => {
    process.env.AZURE_SUBSCRIPTION_ID = '';
    const { getAppMetrics } = await import('./metrics.js');
    await expect(getAppMetrics({ containerAppName: 'x' })).rejects.toThrow(
      /AZURE_SUBSCRIPTION_ID not configured/,
    );
    process.env.AZURE_SUBSCRIPTION_ID = 'sub-test';
  });
});
