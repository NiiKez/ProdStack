/**
 * Azure Monitor metrics wrapper for a user's Container App.
 *
 * Mirrors `containerApps.ts`'s two-branch shape behind a single contract so the
 * Metrics tab in the frontend never needs to know which is active:
 *
 *  - **Stub** (`AZURE_STUB=true`): returns deterministic, plausibly-shaped fake
 *    series (values derived from the bucket index, NOT random) so tests and
 *    local dev render the chart without touching Azure.
 *
 *  - **Real** (`AZURE_STUB=false`): queries Azure Monitor via
 *    `@azure/monitor-query`'s `MetricsQueryClient.queryResource(...)` against the
 *    Container App's resource URI. Credentials come from
 *    `DefaultAzureCredential` (the API's system-assigned managed identity in
 *    prod). One query per metric — each Container Apps metric uses its own
 *    aggregation (CPU=Average, Replicas=Maximum, Requests=Total) — and a failing
 *    metric degrades to an empty-points series rather than failing the whole
 *    request.
 *
 * The public field names (`MetricKey`/`MetricPoint.t`/`MetricPoint.v`/…) are a
 * contract the frontend depends on — keep them stable.
 */
import { MetricsQueryClient, type MetricsQueryResult } from '@azure/monitor-query';
import { DefaultAzureCredential } from '@azure/identity';

import { env } from '../../env.js';
import { logger } from '../../lib/logger.js';

// --- Public contract -------------------------------------------------------

export type MetricKey = 'cpu' | 'memory' | 'replicas' | 'requests';
export type MetricRange = '1h' | '6h' | '24h';

/** A single time bucket. `v` is `null` when the bucket had no data. */
export interface MetricPoint {
  /** ISO-8601 timestamp at the start of the bucket. */
  t: string;
  v: number | null;
}

export interface MetricSeries {
  key: MetricKey;
  label: string;
  unit: string;
  points: MetricPoint[];
}

export interface AppMetrics {
  range: MetricRange;
  /** ISO-8601 start of the window. */
  start: string;
  /** ISO-8601 end of the window (≈ now). */
  end: string;
  intervalMinutes: number;
  series: MetricSeries[];
}

export interface GetAppMetricsOpts {
  containerAppName: string;
  range?: MetricRange;
}

// --- Range / metric configuration ------------------------------------------

type Aggregation = 'Average' | 'Maximum' | 'Total';

interface RangeConfig {
  /** Bucket size in minutes. */
  intervalMinutes: number;
  /** Azure granularity (ISO-8601 duration) matching `intervalMinutes`. */
  granularity: string;
  /** Window length as an ISO-8601 duration for the query timespan. */
  timespanDuration: string;
}

const RANGE_CONFIG: Record<MetricRange, RangeConfig> = {
  '1h': { intervalMinutes: 5, granularity: 'PT5M', timespanDuration: 'PT1H' },
  '6h': { intervalMinutes: 15, granularity: 'PT15M', timespanDuration: 'PT6H' },
  '24h': { intervalMinutes: 60, granularity: 'PT1H', timespanDuration: 'PT24H' },
};

const DEFAULT_RANGE: MetricRange = '1h';

const NANOCORES_PER_CORE = 1e9;
const BYTES_PER_MIB = 1048576;

interface MetricSpec {
  key: MetricKey;
  /** The Azure Container Apps metric name. */
  azureMetric: string;
  aggregation: Aggregation;
  label: string;
  unit: string;
  /** Convert the raw Azure aggregation value to the series' display unit. */
  convert: (raw: number) => number;
}

const METRIC_SPECS: MetricSpec[] = [
  {
    key: 'cpu',
    azureMetric: 'UsageNanoCores',
    aggregation: 'Average',
    label: 'CPU',
    unit: 'cores',
    convert: (raw) => raw / NANOCORES_PER_CORE,
  },
  {
    key: 'memory',
    azureMetric: 'WorkingSetBytes',
    aggregation: 'Average',
    label: 'Memory',
    unit: 'MiB',
    convert: (raw) => raw / BYTES_PER_MIB,
  },
  {
    key: 'replicas',
    azureMetric: 'Replicas',
    aggregation: 'Maximum',
    label: 'Replicas',
    unit: '',
    convert: (raw) => raw,
  },
  {
    key: 'requests',
    azureMetric: 'Requests',
    aggregation: 'Total',
    label: 'Requests',
    unit: 'req',
    convert: (raw) => raw,
  },
];

function resolveRange(range: MetricRange | undefined): MetricRange {
  return range ?? DEFAULT_RANGE;
}

// --- Stub branch -----------------------------------------------------------

/**
 * Pseudo-deterministic wobble in `[0, 1)` keyed on the bucket index and a
 * per-metric offset. Uses a fixed irrational multiplier (not `Math.random`) so
 * the generated shape is stable across runs — tests assert on shape, not exact
 * values.
 */
function wobble(index: number, offset: number): number {
  const x = Math.sin(index * 1.3 + offset) * 0.5 + 0.5;
  return x; // already in [0, 1)
}

function stubValueFor(key: MetricKey, index: number): number {
  switch (key) {
    case 'cpu':
      // ~0.05–0.4 cores
      return Number((0.05 + wobble(index, 0) * 0.35).toFixed(4));
    case 'memory':
      // ~60–180 MiB
      return Number((60 + wobble(index, 1.7) * 120).toFixed(2));
    case 'replicas':
      // 0 or 1 (scale-to-zero apps)
      return wobble(index, 3.1) > 0.4 ? 1 : 0;
    case 'requests':
      // small per-bucket counts
      return Math.round(wobble(index, 4.6) * 12);
  }
}

function stubMetrics(opts: GetAppMetricsOpts): AppMetrics {
  const range = resolveRange(opts.range);
  const cfg = RANGE_CONFIG[range];
  const stepMs = cfg.intervalMinutes * 60_000;
  const end = new Date();
  // Snap end to the bucket boundary so timestamps are clean multiples.
  const endMs = Math.floor(end.getTime() / stepMs) * stepMs;
  const count = Math.round(
    durationMinutes(cfg.timespanDuration) / cfg.intervalMinutes,
  );
  const startMs = endMs - (count - 1) * stepMs;

  const series: MetricSeries[] = METRIC_SPECS.map((spec) => {
    const points: MetricPoint[] = [];
    for (let i = 0; i < count; i++) {
      points.push({
        t: new Date(startMs + i * stepMs).toISOString(),
        v: stubValueFor(spec.key, i),
      });
    }
    return { key: spec.key, label: spec.label, unit: spec.unit, points };
  });

  return {
    range,
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    intervalMinutes: cfg.intervalMinutes,
    series,
  };
}

/** Minutes encoded by the small set of ISO-8601 durations this module emits. */
function durationMinutes(duration: string): number {
  switch (duration) {
    case 'PT1H':
      return 60;
    case 'PT6H':
      return 360;
    case 'PT24H':
      return 1440;
    default: {
      // Fallback parser for PT<h>H / PT<m>M so a future range can't silently
      // produce a zero-length series.
      const h = /PT(\d+)H/.exec(duration);
      const m = /PT(\d+)M/.exec(duration);
      return (h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0);
    }
  }
}

// --- Real branch -----------------------------------------------------------

let cachedClient: MetricsQueryClient | undefined;

function requireSubscriptionId(): string {
  if (!env.AZURE_SUBSCRIPTION_ID) {
    throw new Error(
      'AZURE_SUBSCRIPTION_ID not configured — set AZURE_STUB=true for local dev',
    );
  }
  return env.AZURE_SUBSCRIPTION_ID;
}

function requireResourceGroup(): string {
  if (!env.AZURE_RESOURCE_GROUP) {
    throw new Error(
      'AZURE_RESOURCE_GROUP not configured — set AZURE_STUB=true for local dev',
    );
  }
  return env.AZURE_RESOURCE_GROUP;
}

function getClient(): MetricsQueryClient {
  if (cachedClient) return cachedClient;
  cachedClient = new MetricsQueryClient(new DefaultAzureCredential());
  return cachedClient;
}

function resourceUriFor(containerAppName: string): string {
  return (
    `/subscriptions/${requireSubscriptionId()}` +
    `/resourceGroups/${requireResourceGroup()}` +
    `/providers/Microsoft.App/containerApps/${containerAppName}`
  );
}

/** Pull the aggregation field this spec asked for off a single datum. */
function aggregationField(
  datum: { average?: number; maximum?: number; total?: number },
  aggregation: Aggregation,
): number | undefined {
  switch (aggregation) {
    case 'Average':
      return datum.average;
    case 'Maximum':
      return datum.maximum;
    case 'Total':
      return datum.total;
  }
}

/**
 * Map one Azure metric query result into our `MetricPoint[]`. Reads the FIRST
 * timeseries (Container Apps metrics aren't dimensioned here) and converts each
 * datum's aggregation field through the spec's unit conversion. A missing field
 * becomes `null` (no data in that bucket).
 */
function pointsFromResult(result: MetricsQueryResult, spec: MetricSpec): MetricPoint[] {
  const metric = result.metrics[0];
  const data = metric?.timeseries?.[0]?.data ?? [];
  return data.map((datum) => {
    const raw = aggregationField(datum, spec.aggregation);
    return {
      t:
        datum.timeStamp instanceof Date
          ? datum.timeStamp.toISOString()
          : new Date(datum.timeStamp as unknown as string).toISOString(),
      v: raw === undefined ? null : spec.convert(raw),
    };
  });
}

async function realMetricSeries(
  client: MetricsQueryClient,
  resourceUri: string,
  spec: MetricSpec,
  cfg: RangeConfig,
): Promise<MetricSeries> {
  try {
    const result = await client.queryResource(resourceUri, [spec.azureMetric], {
      granularity: cfg.granularity,
      timespan: { duration: cfg.timespanDuration },
      aggregations: [spec.aggregation],
    });
    return {
      key: spec.key,
      label: spec.label,
      unit: spec.unit,
      points: pointsFromResult(result, spec),
    };
  } catch (err) {
    // Per-metric resilience: log and degrade to an empty series so one failing
    // metric (e.g. a metric not yet emitted by a brand-new app) doesn't blank
    // the whole chart.
    logger.warn(
      { err, metric: spec.azureMetric, resourceUri },
      'metrics: query failed for metric, returning empty series',
    );
    return { key: spec.key, label: spec.label, unit: spec.unit, points: [] };
  }
}

async function realMetrics(opts: GetAppMetricsOpts): Promise<AppMetrics> {
  const range = resolveRange(opts.range);
  const cfg = RANGE_CONFIG[range];
  const client = getClient();
  const resourceUri = resourceUriFor(opts.containerAppName);

  const series = await Promise.all(
    METRIC_SPECS.map((spec) => realMetricSeries(client, resourceUri, spec, cfg)),
  );

  const end = new Date();
  const start = new Date(end.getTime() - durationMinutes(cfg.timespanDuration) * 60_000);
  return {
    range,
    start: start.toISOString(),
    end: end.toISOString(),
    intervalMinutes: cfg.intervalMinutes,
    series,
  };
}

// --- Public API ------------------------------------------------------------

export function isStub(): boolean {
  return env.AZURE_STUB;
}

/**
 * Fetch the four standard Container Apps metrics (CPU, memory, replicas,
 * requests) for `containerAppName` over `range` (default `1h`), shaped for the
 * Metrics tab. Never throws on a single failing metric; the whole call may
 * throw only on a hard credential/config error.
 */
export async function getAppMetrics(opts: GetAppMetricsOpts): Promise<AppMetrics> {
  return isStub() ? stubMetrics(opts) : realMetrics(opts);
}
