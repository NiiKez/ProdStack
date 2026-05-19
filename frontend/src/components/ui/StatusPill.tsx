import { cn } from '@/lib/cn';
import { IN_FLIGHT_STATUSES, statusVisual, type BuildStatus, type StatusTone } from '@/lib/status';
import { PulsingDot } from './PulsingDot';

export interface StatusPillProps {
  status: BuildStatus;
  className?: string;
}

const TONE_STYLES: Record<StatusTone, string> = {
  queued: 'bg-sky-500/10 text-sky-300 border border-sky-500/30',
  building: 'bg-amber-500/10 text-amber-300 border border-amber-500/30',
  ready: 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/30',
  failed: 'bg-rose-500/10 text-rose-300 border border-rose-500/30',
  neutral: 'bg-slate-700/40 text-slate-300 border border-slate-600/50',
};

export function StatusPill({ status, className }: StatusPillProps) {
  const visual = statusVisual[status];
  const pulsing = IN_FLIGHT_STATUSES.has(status) && visual.pulsing;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium',
        TONE_STYLES[visual.tone],
        className
      )}
    >
      <PulsingDot color={visual.tone} pulsing={pulsing} />
      <span>{visual.label}</span>
    </span>
  );
}
