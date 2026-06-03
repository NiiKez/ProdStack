import { useId, useMemo, type JSX } from 'react';
import {
  buildAreaPath,
  buildLinePath,
  formatMetricValue,
  niceMax,
  seriesStats,
  type MetricSeries,
} from '@/lib/metrics';

/** SVG user-space drawing box. The chart scales to its container via the
 *  viewBox + `width:100%`, so these are aspect-ratio units, not pixels. */
const VIEW_W = 600;
const VIEW_H = 160;
/** Fraction positions for the faint horizontal gridlines (top → middle). The
 *  baseline (bottom) is drawn separately and slightly stronger. */
const GRID_FRACTIONS = [0.25, 0.5, 0.75];
/** Theme accent (lime/chartreuse) — mirrors `--color-accent` in index.css. */
const DEFAULT_COLOR = '#cbf94e';

export interface MetricsChartProps {
  series: MetricSeries;
  /** Line/fill color; defaults to the lime accent. */
  color?: string;
}

/**
 * Presentational mini-chart for a single metric series. No data fetching and no
 * state — give it a `MetricSeries` and it renders a titled inline SVG area+line
 * chart with a min/max/avg stat line. An idle Container App (scaled to zero)
 * legitimately reports no datapoints; in that case we show a muted placeholder
 * of the same height rather than an empty frame.
 */
export function MetricsChart({ series, color = DEFAULT_COLOR }: MetricsChartProps): JSX.Element {
  const gradId = useId();

  const { stats, max, linePath, areaPath, hasData } = useMemo(() => {
    const stats = seriesStats(series);
    const max = niceMax(series.points.map((p) => p.v ?? 0));
    const linePath = buildLinePath(series.points, VIEW_W, VIEW_H, max);
    const areaPath = buildAreaPath(series.points, VIEW_W, VIEW_H, max);
    // A line needs ≥2 renderable points; buildLinePath returns '' otherwise.
    const hasData = linePath !== '';
    return { stats, max, linePath, areaPath, hasData };
  }, [series]);

  const latest = formatMetricValue(series.key, stats.last);

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-4 text-slate-100 shadow-sm">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-medium text-slate-300">{series.label}</h3>
        <span className="font-mono text-sm font-semibold text-accent tabular-nums">
          {latest}
        </span>
      </div>

      {hasData ? (
        <>
          <svg
            viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`${series.label} over time`}
            className="block w-full"
            style={{ height: 'auto' }}
          >
            <defs>
              <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.28} />
                <stop offset="100%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>

            {/* faint gridlines */}
            {GRID_FRACTIONS.map((f) => (
              <line
                key={f}
                x1={0}
                x2={VIEW_W}
                y1={VIEW_H * f}
                y2={VIEW_H * f}
                stroke="currentColor"
                strokeWidth={1}
                className="text-slate-700/50"
              />
            ))}
            {/* baseline */}
            <line
              x1={0}
              x2={VIEW_W}
              y1={VIEW_H}
              y2={VIEW_H}
              stroke="currentColor"
              strokeWidth={1}
              className="text-slate-700"
            />

            {/* filled area under the curve */}
            {areaPath && <path d={areaPath} fill={`url(#${gradId})`} stroke="none" />}
            {/* the line itself */}
            <path
              d={linePath}
              fill="none"
              stroke={color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          </svg>

          <dl className="mt-3 flex items-center justify-between text-xs text-slate-400 tabular-nums">
            <div className="flex items-center gap-1.5">
              <dt className="text-slate-500">min</dt>
              <dd className="font-mono text-slate-300">
                {formatMetricValue(series.key, stats.min)}
              </dd>
            </div>
            <div className="flex items-center gap-1.5">
              <dt className="text-slate-500">avg</dt>
              <dd className="font-mono text-slate-300">
                {formatMetricValue(series.key, stats.avg)}
              </dd>
            </div>
            <div className="flex items-center gap-1.5">
              <dt className="text-slate-500">max</dt>
              <dd className="font-mono text-slate-300">
                {formatMetricValue(series.key, max === 1 && stats.max === 0 ? 0 : stats.max)}
              </dd>
            </div>
          </dl>
        </>
      ) : (
        <div
          className="flex flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-slate-800 bg-slate-900/40 text-center"
          style={{ aspectRatio: `${VIEW_W} / ${VIEW_H}` }}
        >
          <p className="text-sm font-medium text-slate-400">No data yet</p>
          <p className="max-w-xs px-4 text-xs text-slate-500">
            Idle apps scale to zero, so there may be no datapoints until traffic arrives.
          </p>
        </div>
      )}
    </div>
  );
}
