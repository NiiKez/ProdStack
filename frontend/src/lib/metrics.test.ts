import { describe, it, expect } from 'vitest';
import {
  niceMax,
  seriesStats,
  formatMetricValue,
  buildLinePath,
  buildAreaPath,
  type MetricPoint,
  type MetricSeries,
} from '@/lib/metrics';

function pts(values: Array<number | null>): MetricPoint[] {
  return values.map((v, i) => ({ t: `2026-06-03T00:0${i}:00Z`, v }));
}

function series(key: MetricSeries['key'], values: Array<number | null>): MetricSeries {
  return { key, label: key, unit: '', points: pts(values) };
}

describe('niceMax', () => {
  it('returns 1 for empty input', () => {
    expect(niceMax([])).toBe(1);
  });

  it('returns 1 for an all-zero series', () => {
    expect(niceMax([0, 0, 0])).toBe(1);
  });

  it('returns 1 when every value is non-finite/NaN', () => {
    expect(niceMax([NaN, Infinity, -Infinity])).toBe(1);
  });

  it('rounds up to a nice 1/2/5 × 10^n bound', () => {
    expect(niceMax([0.37])).toBe(0.5);
    expect(niceMax([0.12])).toBe(0.2);
    expect(niceMax([6])).toBe(10);
    expect(niceMax([128])).toBe(200);
    expect(niceMax([42])).toBe(50);
  });

  it('is always >= the peak value', () => {
    for (const v of [0.01, 0.9, 3, 17, 233, 999]) {
      expect(niceMax([v])).toBeGreaterThanOrEqual(v);
    }
  });

  it('returns a positive finite number for negatives', () => {
    expect(niceMax([-5, -1])).toBe(1);
  });
});

describe('seriesStats', () => {
  it('ignores null points for min/max/avg', () => {
    const s = seriesStats(series('cpu', [2, null, 4, null, 6]));
    expect(s.min).toBe(2);
    expect(s.max).toBe(6);
    expect(s.avg).toBe(4); // (2+4+6)/3
  });

  it('last is the most recent NON-null value', () => {
    expect(seriesStats(series('cpu', [1, 2, null])).last).toBe(2);
    expect(seriesStats(series('cpu', [1, null, 3])).last).toBe(3);
  });

  it('last is null when every point is null', () => {
    const s = seriesStats(series('cpu', [null, null, null]));
    expect(s.last).toBeNull();
    expect(s.min).toBe(0);
    expect(s.max).toBe(0);
    expect(s.avg).toBe(0);
  });

  it('handles an empty series without NaN', () => {
    const s = seriesStats(series('memory', []));
    expect(s).toEqual({ min: 0, max: 0, last: null, avg: 0 });
  });
});

describe('formatMetricValue', () => {
  it('formats cpu with 2 decimals + cores', () => {
    expect(formatMetricValue('cpu', 0.12345)).toBe('0.12 cores');
    expect(formatMetricValue('cpu', 1)).toBe('1.00 cores');
  });

  it('formats memory as rounded MiB', () => {
    expect(formatMetricValue('memory', 128.6)).toBe('129 MiB');
    expect(formatMetricValue('memory', 0)).toBe('0 MiB');
  });

  it('formats replicas as a rounded integer', () => {
    expect(formatMetricValue('replicas', 1)).toBe('1');
    expect(formatMetricValue('replicas', 2.4)).toBe('2');
  });

  it('formats requests with a req suffix', () => {
    expect(formatMetricValue('requests', 42)).toBe('42 req');
  });

  it('renders null as an em dash for every key', () => {
    for (const key of ['cpu', 'memory', 'replicas', 'requests'] as const) {
      expect(formatMetricValue(key, null)).toBe('—');
    }
  });

  it('renders non-finite as an em dash', () => {
    expect(formatMetricValue('cpu', NaN)).toBe('—');
    expect(formatMetricValue('memory', Infinity)).toBe('—');
  });
});

describe('buildLinePath', () => {
  it('returns empty string for empty input', () => {
    expect(buildLinePath([], 600, 160, 10)).toBe('');
  });

  it('returns empty string for fewer than 2 renderable points', () => {
    expect(buildLinePath(pts([5]), 600, 160, 10)).toBe('');
    expect(buildLinePath(pts([null, 5, null]), 600, 160, 10)).toBe('');
  });

  it('produces a path for a 3-point series with the right number of coords', () => {
    const d = buildLinePath(pts([1, 2, 3]), 600, 160, 4);
    // one M + two L commands = 3 coordinate pairs
    expect((d.match(/[ML]/g) ?? []).length).toBe(3);
    expect(d).not.toContain('NaN');
    expect(d.startsWith('M')).toBe(true);
  });

  it('breaks into separate segments around null gaps', () => {
    // [1,2] | gap | [4,5]  → two M commands, four coords total
    const d = buildLinePath(pts([1, 2, null, 4, 5]), 600, 160, 6);
    expect((d.match(/M/g) ?? []).length).toBe(2);
    expect((d.match(/[ML]/g) ?? []).length).toBe(4);
    expect(d).not.toContain('NaN');
  });

  it('never emits NaN even with a zero/invalid max', () => {
    expect(buildLinePath(pts([0, 0, 0]), 600, 160, 0)).not.toContain('NaN');
    expect(buildLinePath(pts([1, 2, 3]), 600, 160, NaN)).not.toContain('NaN');
  });
});

describe('buildAreaPath', () => {
  it('returns empty string for empty / <2 renderable points', () => {
    expect(buildAreaPath([], 600, 160, 10)).toBe('');
    expect(buildAreaPath(pts([5]), 600, 160, 10)).toBe('');
    expect(buildAreaPath(pts([null]), 600, 160, 10)).toBe('');
  });

  it('produces a closed path (Z) for a 3-point series with no NaN', () => {
    const d = buildAreaPath(pts([1, 2, 3]), 600, 160, 4);
    expect(d).not.toContain('NaN');
    expect(d).toContain('Z');
    expect(d.startsWith('M')).toBe(true);
  });

  it('closes one subpath per non-null segment', () => {
    const d = buildAreaPath(pts([1, 2, null, 4, 5]), 600, 160, 6);
    expect((d.match(/Z/g) ?? []).length).toBe(2);
    expect((d.match(/M/g) ?? []).length).toBe(2);
    expect(d).not.toContain('NaN');
  });

  it('never emits NaN with a zero max', () => {
    expect(buildAreaPath(pts([0, 0, 0]), 600, 160, 0)).not.toContain('NaN');
  });
});
