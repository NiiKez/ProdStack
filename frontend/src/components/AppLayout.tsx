import { type ReactNode } from 'react';
import { NavLink, Link, useNavigate } from 'react-router-dom';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { LogOut, Settings as SettingsIcon } from 'lucide-react';
import { Avatar, useToast } from '@/components/ui';
import { cn } from '@/lib/cn';
import { api, ApiError } from '@/lib/api';
import { useCurrentUser } from '@/hooks/useCurrentUser';

interface NavItem {
  to: string;
  label: string;
}

const NAV_ITEMS: NavItem[] = [
  { to: '/dashboard', label: 'Projects' },
  { to: '/deployments', label: 'Deployments' },
  { to: '/activity', label: 'Activity' },
  { to: '/integrations', label: 'Integrations' },
];

interface AppLayoutProps {
  children: ReactNode;
}

export function AppLayout({ children }: AppLayoutProps) {
  const { data: user } = useCurrentUser();
  const toast = useToast();
  const navigate = useNavigate();

  const handleSignOut = async () => {
    try {
      await api<void>('/api/auth/signout', { method: 'POST' });
      window.location.assign('/');
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : 'Could not sign out. Please try again.';
      toast.toast({ variant: 'error', title: 'Sign-out failed', description: message });
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="sticky top-0 z-30 border-b border-slate-800/80 bg-slate-950/85 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-7xl items-center gap-6 px-6">
          <Link
            to="/dashboard"
            className="flex items-center gap-2 text-sm font-semibold tracking-tight text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950 rounded"
          >
            <span className="inline-flex h-6 w-6 items-center justify-center rounded bg-indigo-600 text-[10px] font-bold text-white">
              PS
            </span>
            <span>ProdStack</span>
          </Link>

          <nav aria-label="Primary" className="flex flex-1 items-center gap-1">
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/dashboard'}
                className={({ isActive }) =>
                  cn(
                    'relative inline-flex h-14 items-center px-3 text-sm transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950 rounded',
                    isActive
                      ? 'text-slate-100 after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:rounded-t after:bg-indigo-500'
                      : 'text-slate-400 hover:text-slate-200',
                  )
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="flex items-center">
            <DropdownMenu.Root>
              <DropdownMenu.Trigger
                className="inline-flex items-center gap-2 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
                aria-label="Open user menu"
              >
                <Avatar
                  src={user?.avatarUrl ?? undefined}
                  alt={user?.githubLogin ?? 'User'}
                  size="sm"
                />
              </DropdownMenu.Trigger>

              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  align="end"
                  sideOffset={8}
                  className="min-w-44 overflow-hidden rounded-lg border border-slate-800 bg-slate-900 p-1 text-sm text-slate-200 shadow-xl focus-visible:outline-none"
                >
                  {user ? (
                    <div className="px-2 py-1.5">
                      <div className="text-xs uppercase tracking-wide text-slate-500">
                        Signed in as
                      </div>
                      <div className="truncate text-sm text-slate-100">{user.githubLogin}</div>
                    </div>
                  ) : null}
                  <DropdownMenu.Separator className="my-1 h-px bg-slate-800" />
                  <DropdownMenu.Item
                    onSelect={(event: Event) => {
                      event.preventDefault();
                      navigate('/settings');
                    }}
                    className="flex cursor-pointer select-none items-center gap-2 rounded px-2 py-1.5 outline-none data-[highlighted]:bg-slate-800 data-[highlighted]:text-slate-100"
                  >
                    <SettingsIcon className="h-4 w-4" aria-hidden />
                    Settings
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    onSelect={(event: Event) => {
                      event.preventDefault();
                      void handleSignOut();
                    }}
                    className="flex cursor-pointer select-none items-center gap-2 rounded px-2 py-1.5 text-rose-300 outline-none data-[highlighted]:bg-rose-500/10 data-[highlighted]:text-rose-200"
                  >
                    <LogOut className="h-4 w-4" aria-hidden />
                    Sign out
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl px-6 py-8">{children}</main>
    </div>
  );
}
