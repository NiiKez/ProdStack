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
