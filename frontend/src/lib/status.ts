export type BuildStatus =
  | 'queued'
  | 'cloning'
  | 'building'
  | 'pushing'
  | 'deploying'
  | 'ready'
  | 'failed'
  | 'cancelled';

export const IN_FLIGHT_STATUSES: ReadonlySet<BuildStatus> = new Set<BuildStatus>([
  'queued',
  'cloning',
  'building',
  'pushing',
  'deploying',
]);

export type StatusTone = 'queued' | 'building' | 'ready' | 'failed' | 'neutral';

export interface StatusVisual {
  label: string;
  tone: StatusTone;
  pulsing: boolean;
}

export const statusVisual: Record<BuildStatus, StatusVisual> = {
  queued: { label: 'Queued', tone: 'queued', pulsing: true },
  cloning: { label: 'Cloning', tone: 'building', pulsing: true },
  building: { label: 'Building', tone: 'building', pulsing: true },
  pushing: { label: 'Pushing', tone: 'building', pulsing: true },
  deploying: { label: 'Deploying', tone: 'building', pulsing: true },
  ready: { label: 'Ready', tone: 'ready', pulsing: false },
  failed: { label: 'Failed', tone: 'failed', pulsing: false },
  cancelled: { label: 'Cancelled', tone: 'neutral', pulsing: false },
};

const KNOWN_STATUSES = new Set<string>(Object.keys(statusVisual));

/**
 * The API serializes Prisma's `BuildStatus` enum in UPPERCASE (`READY`), but
 * our UI vocabulary is lowercase. Normalize at the boundary so a raw API
 * value can be passed straight to `StatusPill` / `statusVisual` without every
 * call site remembering to `.toLowerCase()`. Unknown values fall back to
 * `queued` (in-flight look) rather than crashing on an undefined visual.
 */
export function toBuildStatus(raw: string | null | undefined): BuildStatus {
  if (typeof raw !== 'string') return 'queued';
  const lower = raw.toLowerCase();
  return KNOWN_STATUSES.has(lower) ? (lower as BuildStatus) : 'queued';
}

export function isInFlight(raw: string | null | undefined): boolean {
  // "No status" means there is no build at all (e.g. a freshly-created project),
  // which is NOT in-flight. `toBuildStatus` maps undefined → 'queued' so unknown
  // values get an in-flight *display*, but treating a missing build as in-flight
  // would wrongly disable the first "Trigger build" and keep polling idle pages.
  if (typeof raw !== 'string' || raw === '') return false;
  return IN_FLIGHT_STATUSES.has(toBuildStatus(raw));
}
