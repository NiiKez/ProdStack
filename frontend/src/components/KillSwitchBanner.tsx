import { AlertTriangle } from 'lucide-react';
import { usePlatformStatus } from '@/hooks/usePlatformStatus';

/**
 * Full-width banner shown only when the platform is in degrade mode
 * (`killSwitch: true` from `/api/health`). Existing deployed apps keep
 * serving; only new builds/deploys are paused. Renders nothing otherwise.
 */
export function KillSwitchBanner() {
  const { data } = usePlatformStatus();

  if (!data?.killSwitch) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="w-full border-b border-amber-500/40 bg-amber-500/15 text-amber-100"
    >
      <div className="mx-auto flex w-full max-w-7xl items-center gap-3 px-6 py-2.5 text-sm">
        <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" aria-hidden />
        <p>
          <span className="font-semibold">Builds paused — usage limit reached.</span>{' '}
          <span className="text-amber-200/90">
            Existing apps keep serving; new deploys are temporarily disabled.
          </span>
        </p>
      </div>
    </div>
  );
}
