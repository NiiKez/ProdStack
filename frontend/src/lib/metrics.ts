/**
 * Metric contract — MUST match the backend's `/api/projects/:id/metrics`
 * serialization exactly. The backend returns one `AppMetrics` envelope per
 * request; each `MetricSeries.points` is a dense, evenly-spaced timeline whose
 * gaps (no datapoint — e.g. while the Container App was scaled to zero) are
 * `null`, NOT `0`. Helpers below treat `null` as "missing", never as a value.
 */

export type MetricKey = 'cpu' | 'memory' | 'replicas' | 'requests';
export type MetricRange = '1h' | '6h' | '24h';

export interface MetricPoint {
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
  start: string;
  end: string;
  intervalMinutes: number;
  series: MetricSeries[];
}

/** Fraction of the chart height reserved above the tallest point so the line
 *  never touches the top edge. Shared by the path builders below. */
const TOP_PADDING = 0.08;

/**
 * A "nice" rounded upper bound for the y-axis given the raw values. We take the
 * max, then round up to 1/2/5 × a power of ten so gridlines land on readable
 * numbers (e.g. 0.37 → 0.5, 6 → 10, 128 → 200). Empty input, all-`null`, or an
 * all-zero series collapse to `1` so the axis is always a positive, finite
 * number (and the path builders never divide by zero).
 */
export function niceMax(values: number[]): number {
  const finite = values.filter((v) => Number.isFinite(v));
  const peak = finite.length ? Math.max(...finite) : 0;
  if (!Number.isFinite(peak) || peak <= 0) return 1;

  const magnitude = Math.pow(10, Math.floor(Math.log10(peak)));
  const normalized = peak / magnitude; // in [1, 10)
  let nice: number;
  if (normalized <= 1) nice = 1;
  else if (normalized <= 2) nice = 2;
  else if (normalized <= 5) nice = 5;
  else nice = 10;
  return nice * magnitude;
}

/**
 * Summary stats over a series, ignoring `null` points entirely.
 * - `min`/`max`/`avg` are computed over the non-null values (all `0` when the
 *   series has no datapoints, so the UI shows zeros rather than NaN/Infinity).
 * - `last` is the most recent non-null value in timeline order, or `null` when
 *   every point is missing.
 */
export function seriesStats(series: MetricSeries): {
  min: number;
  max: number;
  last: number | null;
  avg: number;
} {
  const values: number[] = [];
  let last: number | null = null;
  for (const p of series.points) {
    if (p.v !== null && Number.isFinite(p.v)) {
      values.push(p.v);
      last = p.v;
    }
  }
  if (values.length === 0) {
    return { min: 0, max: 0, last: null, avg: 0 };
  }
  const sum = values.reduce((acc, v) => acc + v, 0);
  return {
    min: Math.min(...values),
    max: Math.max(...values),
    last,
    avg: sum / values.length,
  };
}

/**
 * Human-readable rendering of a single metric value, per key:
 *   cpu     → '0.12 cores' (2 dp)
 *   memory  → '128 MiB'    (0 dp)
 *   replicas→ '1'          (0 dp)
 *   requests→ '42 req'     (0 dp)
 * A `null` value (no datapoint) renders as an em dash.
 */
export function formatMetricValue(key: MetricKey, v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '—';
  switch (key) {
    case 'cpu':
      return `${v.toFixed(2)} cores`;
    case 'memory':
      return `${Math.round(v)} MiB`;
    case 'replicas':
      return `${Math.round(v)}`;
    case 'requests':
      return `${Math.round(v)} req`;
    default:
      return `${v}`;
  }
}

/**
 * Map a point index + value to SVG user-space coordinates. x is evenly spaced
 * across `width`; y is scaled into `[0, height]` and inverted (max → top) with a
 * small top padding so the peak doesn't graze the frame. `max` is assumed > 0
 * (callers pass `niceMax(...)`, which guarantees this).
 */
function project(
  i: number,
  v: number,
  count: number,
  width: number,
  height: number,
  max: number
): { x: number; y: number } {
  const x = count <= 1 ? 0 : (i / (count - 1)) * width;
  const usable = height * (1 - TOP_PADDING);
  const clamped = Math.max(0, Math.min(v, max));
  const y = height - (clamped / max) * usable;
  return { x, y };
}

/** Round to 2 dp and strip a trailing `.00`/`0` so paths stay compact and
 *  deterministic (and never carry float noise like `12.000000001`). */
function fmt(n: number): string {
  return Number(n.toFixed(2)).toString();
}

/**
 * SVG `d` for the polyline through the series points. x is evenly spaced across
 * `width`, y scaled to `[0, height]` (inverted; `max` maps near the top).
 * `null` points break the line into separate segments (gaps) — each contiguous
 * run of ≥1 non-null point starts a new `M`/`L` subpath. Returns `''` when there
 * are fewer than 2 *renderable* (non-null) points, since a single dot is not a
 * line. Never emits `NaN`.
 */
export function buildLinePath(
  points: MetricPoint[],
  width: number,
  height: number,
  max: number
): string {
  const safeMax = max > 0 && Number.isFinite(max) ? max : 1;
  const count = points.length;
  const segments: string[][] = [];
  let current: string[] = [];
  for (let i = 0; i < count; i++) {
    const p = points[i];
    if (!p || p.v === null || !Number.isFinite(p.v)) {
      if (current.length) segments.push(current);
      current = [];
      continue;
    }
    const { x, y } = project(i, p.v, count, width, height, safeMax);
    const cmd = current.length === 0 ? 'M' : 'L';
    current.push(`${cmd}${fmt(x)} ${fmt(y)}`);
  }
  if (current.length) segments.push(current);

  // A subpath with a single point draws nothing; require ≥2 points overall.
  const renderable = segments.filter((s) => s.length >= 2);
  if (renderable.length === 0) return '';
  return renderable.map((s) => s.join(' ')).join(' ');
}

/**
 * SVG `d` for a filled area: the same line as `buildLinePath`, but each
 * contiguous (gap-separated) segment is closed straight down to the baseline
 * (`y = height`) and back, so a single `<path fill>` renders translucent fill
 * under the curve. Returns `''` for fewer than 2 renderable points. Never emits
 * `NaN`.
 */
export function buildAreaPath(
  points: MetricPoint[],
  width: number,
  height: number,
  max: number
): string {
  const safeMax = max > 0 && Number.isFinite(max) ? max : 1;
  const count = points.length;
  type Pt = { x: number; y: number };
  const segments: Pt[][] = [];
  let current: Pt[] = [];
  for (let i = 0; i < count; i++) {
    const p = points[i];
    if (!p || p.v === null || !Number.isFinite(p.v)) {
      if (current.length) segments.push(current);
      current = [];
      continue;
    }
    current.push(project(i, p.v, count, width, height, safeMax));
  }
  if (current.length) segments.push(current);

  const renderable = segments.filter((s) => s.length >= 2);
  if (renderable.length === 0) return '';

  return renderable
    .map((seg) => {
      // `renderable` guarantees seg.length >= 2, so both ends exist.
      const first = seg[0]!;
      const lastPt = seg[seg.length - 1]!;
      const line = seg
        .map((pt, idx) => `${idx === 0 ? 'M' : 'L'}${fmt(pt.x)} ${fmt(pt.y)}`)
        .join(' ');
      // close down to the baseline and back to the start, then Z
      return `${line} L${fmt(lastPt.x)} ${fmt(height)} L${fmt(first.x)} ${fmt(height)} Z`;
    })
    .join(' ');
}
