import { cn } from '@/lib/cn';

export type PulsingDotColor = 'queued' | 'building' | 'ready' | 'failed' | 'neutral';

export interface PulsingDotProps {
  color: PulsingDotColor;
  pulsing?: boolean;
  className?: string;
}

const COLOR_INNER: Record<PulsingDotColor, string> = {
  queued: 'bg-sky-400',
  building: 'bg-amber-400',
  ready: 'bg-emerald-400',
  failed: 'bg-rose-400',
  neutral: 'bg-slate-400',
};

const COLOR_PING: Record<PulsingDotColor, string> = {
  queued: 'bg-sky-400/70',
  building: 'bg-amber-400/70',
  ready: 'bg-emerald-400/70',
  failed: 'bg-rose-400/70',
  neutral: 'bg-slate-400/70',
};

export function PulsingDot({ color, pulsing = true, className }: PulsingDotProps) {
  return (
    <span
      aria-hidden
      className={cn('relative inline-flex h-2 w-2 shrink-0', className)}
    >
      {pulsing && (
        <span
          className={cn(
            'absolute inline-flex h-full w-full rounded-full opacity-75 animate-ping motion-reduce:animate-none',
            COLOR_PING[color]
          )}
        />
      )}
      <span className={cn('relative inline-flex h-2 w-2 rounded-full', COLOR_INNER[color])} />
    </span>
  );
}
