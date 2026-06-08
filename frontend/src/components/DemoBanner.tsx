import { Info } from 'lucide-react';
import { useCurrentUser } from '@/hooks/useCurrentUser';

/**
 * Full-width banner shown only when the current session is a sandboxed demo
 * (`isDemo: true` from `/api/auth/me`). Signals that projects and builds are
 * simulated and reset periodically. Renders nothing for real users.
 *
 * Mirrors `KillSwitchBanner`'s structure/placement but uses a blue/info palette
 * (amber is reserved for the kill switch).
 */
export function DemoBanner() {
  const { data } = useCurrentUser();

  if (!data?.isDemo) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="w-full border-b border-sky-500/40 bg-sky-500/15 text-sky-100"
    >
      <div className="mx-auto flex w-full max-w-7xl items-center gap-3 px-6 py-2.5 text-sm">
        <Info className="h-4 w-4 shrink-0 text-sky-400" aria-hidden />
        <p>
          <span className="font-semibold">You&apos;re in a demo sandbox.</span>{' '}
          <span className="text-sky-200/90">
            Projects and builds are simulated and reset periodically.
          </span>
        </p>
      </div>
    </div>
  );
}
