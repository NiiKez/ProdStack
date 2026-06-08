import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Hexagon, Menu, X } from 'lucide-react';
import { Sidebar } from '@/components/Sidebar';
import { KillSwitchBanner } from '@/components/KillSwitchBanner';
import { DemoBanner } from '@/components/DemoBanner';

interface AppLayoutProps {
  children: ReactNode;
}

export function AppLayout({ children }: AppLayoutProps) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  // Close on nav (focus follows the navigation, so don't pull it back).
  const closeMobile = () => setMobileOpen(false);
  // Explicit dismiss (ESC / overlay / X): close and restore focus to the trigger.
  const dismissMobile = () => {
    setMobileOpen(false);
    menuButtonRef.current?.focus();
  };

  // The drawer is a hand-rolled role="dialog" (not Radix), so wire up the modal
  // essentials Radix would give us: ESC-to-close and moving focus into the panel.
  useEffect(() => {
    if (!mobileOpen) return;
    const trigger = menuButtonRef.current;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMobileOpen(false);
        trigger?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    closeButtonRef.current?.focus();
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [mobileOpen]);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      {/* Desktop sidebar — fixed rail */}
      <div className="hidden border-r border-slate-800/70 lg:fixed lg:inset-y-0 lg:left-0 lg:z-40 lg:block">
        <Sidebar />
      </div>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <button
            type="button"
            aria-label="Close navigation"
            className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
            onClick={dismissMobile}
          />
          <div className="fixed inset-y-0 left-0 z-50 border-r border-slate-800/70 shadow-2xl">
            <button
              ref={closeButtonRef}
              type="button"
              aria-label="Close navigation"
              onClick={dismissMobile}
              className="absolute right-3 top-4 z-10 grid h-8 w-8 place-items-center rounded-md text-slate-400 hover:bg-slate-800/60 hover:text-slate-100"
            >
              <X size={18} />
            </button>
            <Sidebar onNavigate={closeMobile} />
          </div>
        </div>
      )}

      {/* Content column */}
      <div className="lg:pl-60">
        {/* Mobile top bar */}
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-slate-800/70 bg-slate-950/85 px-4 backdrop-blur lg:hidden">
          <button
            ref={menuButtonRef}
            type="button"
            aria-label="Open navigation"
            aria-expanded={mobileOpen}
            onClick={() => setMobileOpen(true)}
            className="grid h-9 w-9 place-items-center rounded-md text-slate-300 hover:bg-slate-800/60 hover:text-slate-100"
          >
            <Menu size={20} />
          </button>
          <Link to="/dashboard" className="flex items-center gap-2">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-accent-400 text-accent-ink">
              <Hexagon size={16} strokeWidth={2.5} />
            </span>
            <span className="text-sm font-semibold tracking-tight text-slate-100">ProdStack</span>
          </Link>
        </header>

        <KillSwitchBanner />
        <DemoBanner />

        <main className="mx-auto w-full max-w-7xl px-5 py-8 lg:px-10">{children}</main>
      </div>
    </div>
  );
}
