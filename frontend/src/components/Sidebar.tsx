import { type ComponentType } from 'react';
import { NavLink, Link, useNavigate } from 'react-router-dom';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  Activity as ActivityIcon,
  Globe,
  Hexagon,
  LayoutGrid,
  LogOut,
  Puzzle,
  Settings as SettingsIcon,
  ChevronsUpDown,
} from 'lucide-react';
import { Avatar, useToast } from '@/components/ui';
import { cn } from '@/lib/cn';
import { api, ApiError } from '@/lib/api';
import { useCurrentUser } from '@/hooks/useCurrentUser';

interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<{ size?: number | string; className?: string }>;
  end?: boolean;
}

interface NavSection {
  heading: string;
  items: NavItem[];
}

const SECTIONS: NavSection[] = [
  {
    heading: 'Main',
    items: [
      { to: '/dashboard', label: 'Projects', icon: LayoutGrid, end: true },
      { to: '/deployments', label: 'Deployments', icon: Globe },
      { to: '/activity', label: 'Activity', icon: ActivityIcon },
    ],
  },
  {
    heading: 'Config',
    items: [
      { to: '/settings', label: 'Settings', icon: SettingsIcon },
      { to: '/integrations', label: 'Integrations', icon: Puzzle },
    ],
  },
];

interface SidebarProps {
  /** Called after any nav link is activated — used to close the mobile drawer. */
  onNavigate?: () => void;
}

export function Sidebar({ onNavigate }: SidebarProps) {
  return (
    <aside className="flex h-full w-60 flex-col bg-slate-950">
      <div className="flex h-16 shrink-0 items-center px-5">
        <Link
          to="/dashboard"
          onClick={onNavigate}
          className="group flex items-center gap-2.5 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400"
        >
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-accent-400 text-accent-ink shadow-sm">
            <Hexagon size={18} strokeWidth={2.5} className="fill-accent-ink/10" />
          </span>
          <span className="text-[15px] font-semibold tracking-tight text-slate-100">
            ProdStack
          </span>
        </Link>
      </div>

      <nav aria-label="Primary" className="flex-1 space-y-6 overflow-y-auto px-3 py-4">
        {SECTIONS.map((section) => (
          <div key={section.heading}>
            <p className="px-3 pb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500">
              {section.heading}
            </p>
            <ul className="space-y-0.5">
              {section.items.map((item) => {
                const Icon = item.icon;
                return (
                  <li key={item.to}>
                    <NavLink
                      to={item.to}
                      end={item.end ?? false}
                      onClick={onNavigate}
                      className={({ isActive }) =>
                        cn(
                          'group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400',
                          isActive
                            ? 'bg-slate-800/70 text-slate-50'
                            : 'text-slate-400 hover:bg-slate-800/40 hover:text-slate-100',
                        )
                      }
                    >
                      {({ isActive }) => (
                        <>
                          <Icon
                            size={18}
                            className={cn(
                              'shrink-0 transition-colors',
                              isActive
                                ? 'text-accent-400'
                                : 'text-slate-500 group-hover:text-slate-300',
                            )}
                          />
                          <span>{item.label}</span>
                        </>
                      )}
                    </NavLink>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="shrink-0 border-t border-slate-800/70 p-3">
        <UserMenu />
      </div>
    </aside>
  );
}

function UserMenu() {
  const { data: user } = useCurrentUser();
  const { toast } = useToast();
  const navigate = useNavigate();

  const handleSignOut = async () => {
    try {
      await api<void>('/api/auth/signout', { method: 'POST' });
      window.location.assign('/');
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : 'Could not sign out. Please try again.';
      toast({ variant: 'error', title: 'Sign-out failed', description: message });
    }
  };

  const primary = user?.githubLogin ?? 'Account';
  // Demo sessions never touched GitHub, so don't claim "Signed in with GitHub".
  const secondary = user?.isDemo ? 'Demo sandbox' : (user?.email ?? 'Signed in with GitHub');

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-slate-800/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400"
        aria-label="Open user menu"
      >
        <Avatar src={user?.avatarUrl ?? undefined} alt={primary} size="md" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-slate-100">{primary}</span>
          <span className="block truncate text-xs text-slate-500">{secondary}</span>
        </span>
        <ChevronsUpDown size={16} className="shrink-0 text-slate-500" aria-hidden />
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          side="top"
          sideOffset={8}
          className="z-50 min-w-52 overflow-hidden rounded-lg border border-slate-800 bg-slate-900 p-1 text-sm text-slate-200 shadow-xl focus-visible:outline-none"
        >
          {user ? (
            <div className="px-2 py-1.5">
              <div className="text-xs uppercase tracking-wide text-slate-500">Signed in as</div>
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
  );
}
