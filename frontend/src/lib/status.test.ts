import { describe, it, expect } from 'vitest';
import {
  type BuildStatus,
  IN_FLIGHT_STATUSES,
  statusVisual,
  toBuildStatus,
  isInFlight,
} from '@/lib/status';

// The full canonical set of BuildStatus values, in declaration order.
// Kept as a typed tuple so the data-driven tests below are exhaustive and
// any future addition/removal to the union surfaces as a TS error here.
const ALL_STATUSES: readonly BuildStatus[] = [
  'queued',
  'cloning',
  'building',
  'pushing',
  'deploying',
  'ready',
  'failed',
  'cancelled',
];

const IN_FLIGHT: readonly BuildStatus[] = ['queued', 'cloning', 'building', 'pushing', 'deploying'];
const TERMINAL: readonly BuildStatus[] = ['ready', 'failed', 'cancelled'];

describe('toBuildStatus', () => {
  it('maps every known UPPERCASE API value to its lowercase UI value', () => {
    // The API serializes Prisma's enum in UPPERCASE; the UI vocabulary is lowercase.
    expect(toBuildStatus('QUEUED')).toBe('queued');
    expect(toBuildStatus('CLONING')).toBe('cloning');
    expect(toBuildStatus('BUILDING')).toBe('building');
    expect(toBuildStatus('PUSHING')).toBe('pushing');
    expect(toBuildStatus('DEPLOYING')).toBe('deploying');
    expect(toBuildStatus('READY')).toBe('ready');
    expect(toBuildStatus('FAILED')).toBe('failed');
    expect(toBuildStatus('CANCELLED')).toBe('cancelled');
  });

  it('passes already-lowercase values through unchanged', () => {
    for (const s of ALL_STATUSES) {
      expect(toBuildStatus(s)).toBe(s);
    }
  });

  it('normalizes mixed-case values', () => {
    expect(toBuildStatus('Ready')).toBe('ready');
    expect(toBuildStatus('BuIlDiNg')).toBe('building');
    expect(toBuildStatus('Deploying')).toBe('deploying');
    expect(toBuildStatus('cAnCeLLeD')).toBe('cancelled');
  });

  it('falls back to "queued" for an unknown string', () => {
    expect(toBuildStatus('bogus')).toBe('queued');
    expect(toBuildStatus('done')).toBe('queued');
    expect(toBuildStatus('READYY')).toBe('queued');
    expect(toBuildStatus('  ready  ')).toBe('queued'); // not trimmed -> unknown
  });

  it('falls back to "queued" for null', () => {
    expect(toBuildStatus(null)).toBe('queued');
  });

  it('falls back to "queued" for undefined', () => {
    expect(toBuildStatus(undefined)).toBe('queued');
  });

  it('falls back to "queued" for the empty string', () => {
    expect(toBuildStatus('')).toBe('queued');
  });

  it('falls back to "queued" for non-string-ish runtime inputs', () => {
    // The signature is `string | null | undefined`, but the runtime guard is
    // `typeof raw !== 'string'`, so any non-string value must hit the fallback.
    // Cast through `unknown` to exercise the guard without weakening the type.
    const asRaw = (v: unknown) => v as string | null | undefined;
    expect(toBuildStatus(asRaw(0))).toBe('queued');
    expect(toBuildStatus(asRaw(42))).toBe('queued');
    expect(toBuildStatus(asRaw(true))).toBe('queued');
    expect(toBuildStatus(asRaw({}))).toBe('queued');
    expect(toBuildStatus(asRaw([]))).toBe('queued');
    expect(toBuildStatus(asRaw(NaN))).toBe('queued');
  });

  it('only ever returns a value that has a statusVisual entry', () => {
    const inputs = ['READY', 'building', 'Bogus', '', null, undefined];
    for (const input of inputs) {
      const result = toBuildStatus(input);
      expect(statusVisual[result]).toBeDefined();
    }
  });
});

describe('isInFlight', () => {
  // REGRESSION (real prod bug): a project with NO build at all had its
  // "Trigger build" button stuck disabled because a MISSING status read as
  // in-flight. `isInFlight(undefined)` MUST be false — "no build" is NOT
  // "a build is running".
  it('returns false for undefined (no build) — regression: missing status is NOT in-flight', () => {
    expect(isInFlight(undefined)).toBe(false);
  });

  it('returns false for null', () => {
    expect(isInFlight(null)).toBe(false);
  });

  it('returns false for the empty string', () => {
    expect(isInFlight('')).toBe(false);
  });

  it('returns false for terminal statuses (lowercase)', () => {
    expect(isInFlight('ready')).toBe(false);
    expect(isInFlight('failed')).toBe(false);
    expect(isInFlight('cancelled')).toBe(false);
  });

  it('returns false for terminal statuses (UPPERCASE)', () => {
    expect(isInFlight('READY')).toBe(false);
    expect(isInFlight('FAILED')).toBe(false);
    expect(isInFlight('CANCELLED')).toBe(false);
  });

  it('returns true for in-flight statuses (lowercase)', () => {
    expect(isInFlight('queued')).toBe(true);
    expect(isInFlight('cloning')).toBe(true);
    expect(isInFlight('building')).toBe(true);
    expect(isInFlight('pushing')).toBe(true);
    expect(isInFlight('deploying')).toBe(true);
  });

  it('returns true for in-flight statuses (UPPERCASE)', () => {
    expect(isInFlight('QUEUED')).toBe(true);
    expect(isInFlight('CLONING')).toBe(true);
    expect(isInFlight('BUILDING')).toBe(true);
    expect(isInFlight('PUSHING')).toBe(true);
    expect(isInFlight('DEPLOYING')).toBe(true);
  });

  it('treats an unknown NON-EMPTY string as in-flight (queued display fallback)', () => {
    // A present-but-unrecognized status maps through `toBuildStatus` to the
    // 'queued' display fallback, which IS in-flight — so the pill shows the
    // busy look rather than crashing. This is deliberately different from a
    // MISSING status (undefined/null/''), which is NOT in-flight — see the
    // asymmetry test below. The fix only carves out missing/empty, not unknown.
    expect(isInFlight('bogus')).toBe(true);
    expect(isInFlight('done')).toBe(true);
  });

  // The subtle, intentional asymmetry: `toBuildStatus` maps a missing status to
  // the "queued" DISPLAY fallback (so a pill always renders), but `isInFlight`
  // must NOT treat a missing status as in-flight. These two are deliberately
  // different — do NOT "simplify" `isInFlight` into `IN_FLIGHT_STATUSES.has(toBuildStatus(raw))`,
  // which would re-introduce the prod bug where a build-less project looked busy.
  it('is intentionally asymmetric with toBuildStatus for a missing status', () => {
    expect(toBuildStatus(undefined)).toBe('queued'); // display fallback
    expect(isInFlight(undefined)).toBe(false); // but NOT "in-flight"
    // Same divergence for null and '' for completeness.
    expect(toBuildStatus(null)).toBe('queued');
    expect(isInFlight(null)).toBe(false);
    expect(toBuildStatus('')).toBe('queued');
    expect(isInFlight('')).toBe(false);
  });

  // Data-driven consistency: for every real BuildStatus value, isInFlight must
  // agree exactly with the IN_FLIGHT_STATUSES set. This keeps the predicate and
  // the set from drifting apart if either is edited.
  it('agrees with IN_FLIGHT_STATUSES.has for all 8 BuildStatus values', () => {
    for (const s of ALL_STATUSES) {
      expect(isInFlight(s)).toBe(IN_FLIGHT_STATUSES.has(s));
    }
  });
});

describe('IN_FLIGHT_STATUSES', () => {
  it('contains exactly the five in-flight statuses', () => {
    expect(IN_FLIGHT_STATUSES.size).toBe(IN_FLIGHT.length);
    for (const s of IN_FLIGHT) {
      expect(IN_FLIGHT_STATUSES.has(s)).toBe(true);
    }
  });

  it('does not contain any terminal status', () => {
    for (const s of TERMINAL) {
      expect(IN_FLIGHT_STATUSES.has(s)).toBe(false);
    }
  });
});

describe('statusVisual', () => {
  it('has an entry for every BuildStatus', () => {
    for (const s of ALL_STATUSES) {
      const visual = statusVisual[s];
      expect(visual).toBeDefined();
      expect(typeof visual.label).toBe('string');
      expect(visual.label.length).toBeGreaterThan(0);
    }
  });

  it('has no extra keys beyond the 8 BuildStatus values', () => {
    expect(Object.keys(statusVisual).sort()).toEqual([...ALL_STATUSES].sort());
  });

  it('marks pulsing=true exactly for the in-flight statuses', () => {
    for (const s of ALL_STATUSES) {
      expect(statusVisual[s].pulsing).toBe(IN_FLIGHT_STATUSES.has(s));
    }
  });

  it('uses a known tone for every status', () => {
    const validTones = new Set(['queued', 'building', 'ready', 'failed', 'neutral']);
    for (const s of ALL_STATUSES) {
      expect(validTones.has(statusVisual[s].tone)).toBe(true);
    }
  });
});
