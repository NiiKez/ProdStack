import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity as ActivityIcon,
  Ban,
  CheckCircle2,
  Clock,
  FolderPlus,
  Rocket,
  RotateCcw,
  Trash2,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import {
  Avatar,
  Button,
  Card,
  CommitRef,
  EmptyState,
  ErrorState,
  RelativeTime,
  Skeleton,
} from '@/components/ui';
import { cn } from '@/lib/cn';
import { useActivity, type ActivityFilters } from '@/hooks/useActivity';
import { useProjects } from '@/hooks/useProjects';
import { usePageTitle } from '@/hooks/usePageTitle';
import type { ActivityEvent, ActivityType } from '@/types/api';

interface EventMeta {
  label: string;
  icon: LucideIcon;
  /** Tailwind classes for the circular icon badge (bg + border + text), colored by event type. */
  tone: string;
}

// Per-type semantic badge colors. emerald = success/deploy, rose = failure/destructive,
// amber = rollback (in-progress-ish), sky = queued, accent = project creation, neutral = cancelled.
const TONE = {
  emerald: 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300',
  rose: 'bg-rose-500/10 border-rose-500/30 text-rose-300',
  amber: 'bg-amber-500/10 border-amber-500/30 text-amber-300',
  sky: 'bg-sky-500/10 border-sky-500/30 text-sky-300',
  accent: 'bg-accent-400/10 border-accent-400/30 text-accent-300',
  neutral: 'bg-slate-800/80 border-slate-700 text-slate-400',
} as const;

const EVENT_META: Record<ActivityType, EventMeta> = {
  'build.queued': { label: 'Build queued', icon: Clock, tone: TONE.sky },
  'build.succeeded': { label: 'Build succeeded', icon: CheckCircle2, tone: TONE.emerald },
  'build.failed': { label: 'Build failed', icon: XCircle, tone: TONE.rose },
  'build.cancelled': { label: 'Build cancelled', icon: Ban, tone: TONE.neutral },
  'deployment.created': { label: 'Deployed', icon: Rocket, tone: TONE.emerald },
  'deployment.rollback': { label: 'Rolled back', icon: RotateCcw, tone: TONE.amber },
  'project.created': { label: 'Project created', icon: FolderPlus, tone: TONE.accent },
  'project.deleted': { label: 'Project deleted', icon: Trash2, tone: TONE.rose },
};

/** All known event types, used to render one filter chip per type. */
const ALL_TYPES: ReadonlyArray<ActivityType> = [
  'build.queued',
  'build.succeeded',
  'build.failed',
  'build.cancelled',
  'deployment.created',
  'deployment.rollback',
  'project.created',
  'project.deleted',
];

/** Short labels for the type filter chips (the headline labels read oddly as filters). */
const TYPE_CHIP_LABEL: Record<ActivityType, string> = {
  'build.queued': 'Queued',
  'build.succeeded': 'Succeeded',
  'build.failed': 'Failed',
  'build.cancelled': 'Cancelled',
  'deployment.created': 'Deployed',
  'deployment.rollback': 'Rolled back',
  'project.created': 'Created',
  'project.deleted': 'Deleted',
};

/** Where a row links to, or `null` when the row should not be clickable. */
function eventHref(e: ActivityEvent): string | null {
  switch (e.type) {
    case 'build.queued':
    case 'build.succeeded':
    case 'build.failed':
    case 'build.cancelled':
      return e.buildId ? `/projects/${e.projectId}/builds/${e.buildId}` : null;
    case 'deployment.created':
    case 'deployment.rollback':
      return `/projects/${e.projectId}?tab=deployments`;
    case 'project.created':
      return `/projects/${e.projectId}`;
    case 'project.deleted':
      return null;
    default:
      return null;
  }
}

// ---- Day grouping --------------------------------------------------------

interface DayGroup {
  key: string;
  label: string;
  events: ActivityEvent[];
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return 'Unknown';

  const now = new Date();
  const today = dayKey(now);
  const yesterdayDate = new Date(now);
  yesterdayDate.setDate(now.getDate() - 1);
  const yesterday = dayKey(yesterdayDate);

  const key = dayKey(d);
  if (key === today) return 'Today';
  if (key === yesterday) return 'Yesterday';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Group a newest-first flat list into day buckets, preserving order. */
function groupByDay(events: ActivityEvent[]): DayGroup[] {
  const groups: DayGroup[] = [];
  let current: DayGroup | null = null;

  for (const e of events) {
    const d = new Date(e.ts);
    const key = Number.isNaN(d.getTime()) ? 'unknown' : dayKey(d);
    if (!current || current.key !== key) {
      current = { key, label: dayLabel(e.ts), events: [] };
      groups.push(current);
    }
    current.events.push(e);
  }

  return groups;
}

// ---- Filter chip ---------------------------------------------------------

interface ChipProps {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}

function Chip({ active, onClick, children }: ChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400',
        active
          ? 'border-accent-400/40 bg-accent-400/10 text-accent-300'
          : 'border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-600'
      )}
    >
      {children}
    </button>
  );
}

// ---- Event row -----------------------------------------------------------

function EventRow({ event }: { event: ActivityEvent }) {
  const meta = EVENT_META[event.type];
  const Icon = meta.icon;
  const href = eventHref(event);

  return (
    <li className="group relative flex items-start gap-3 rounded-lg px-2 py-3">
      <span
        aria-hidden
        className={cn(
          'relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border',
          'ring-4 ring-slate-900',
          '[&_svg]:h-4 [&_svg]:w-4',
          meta.tone
        )}
      >
        <Icon />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <p className="min-w-0 text-sm text-slate-300">
            <strong className="font-semibold text-slate-100">{meta.label}</strong>
            {event.projectName && (
              <>
                {' '}
                <span className="text-slate-400">in</span>{' '}
                <span className="font-medium text-slate-200">{event.projectName}</span>
              </>
            )}
          </p>
          <RelativeTime value={event.ts} className="relative z-10 shrink-0 text-xs" />
        </div>

        {(event.commitSha || event.commitMessage || event.commitAuthor) && (
          <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-slate-400">
            {event.commitSha && (
              <span className="relative z-10 shrink-0">
                <CommitRef sha={event.commitSha} />
              </span>
            )}
            {event.commitMessage && (
              <span className="min-w-0 truncate">{event.commitMessage}</span>
            )}
            {event.commitAuthor && (
              <span className="ml-auto flex shrink-0 items-center gap-1.5 text-slate-400">
                <Avatar alt={event.commitAuthor} size="sm" />
                <span className="hidden sm:inline">{event.commitAuthor}</span>
              </span>
            )}
          </div>
        )}
      </div>

      {/* Stretched overlay link: makes the whole row clickable without nesting
          interactive children (CommitRef/Avatar) inside an anchor. */}
      {href && (
        <Link
          to={href}
          aria-label={`${meta.label}${event.projectName ? ` in ${event.projectName}` : ''}`}
          className={cn(
            'absolute inset-0 z-0 rounded-lg',
            'transition-colors hover:bg-slate-800/40',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400'
          )}
        />
      )}
    </li>
  );
}

// ---- Page ----------------------------------------------------------------

export default function Activity() {
  usePageTitle('Activity — ProdStack');

  const [selectedTypes, setSelectedTypes] = useState<ActivityType[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | undefined>(undefined);

  const filters = useMemo<ActivityFilters>(() => {
    const f: ActivityFilters = {};
    if (selectedTypes.length > 0) f.type = selectedTypes;
    if (selectedProjectId) f.projectId = selectedProjectId;
    return f;
  }, [selectedTypes, selectedProjectId]);

  const {
    data,
    isLoading,
    isError,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useActivity(filters);

  const { data: projects } = useProjects();

  const events = useMemo(() => data?.pages.flatMap((p) => p.items) ?? [], [data]);
  const groups = useMemo(() => groupByDay(events), [events]);

  const toggleType = (t: ActivityType) => {
    setSelectedTypes((prev) =>
      prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]
    );
  };

  const selectProject = (id: string) => {
    setSelectedProjectId((prev) => (prev === id ? undefined : id));
  };

  return (
    <div className="flex flex-col gap-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-50">Activity</h1>
        <p className="text-sm text-slate-400">
          A chronological feed of build, deployment, and project events across your projects.
        </p>
      </header>

      {/* Filter bar */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 text-xs font-medium uppercase tracking-wide text-slate-500">
            Type
          </span>
          {ALL_TYPES.map((t) => (
            <Chip key={t} active={selectedTypes.includes(t)} onClick={() => toggleType(t)}>
              {TYPE_CHIP_LABEL[t]}
            </Chip>
          ))}
        </div>

        {projects && projects.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="mr-1 text-xs font-medium uppercase tracking-wide text-slate-500">
              Project
            </span>
            {projects.map((p) => (
              <Chip
                key={p.id}
                active={selectedProjectId === p.id}
                onClick={() => selectProject(p.id)}
              >
                {p.name}
              </Chip>
            ))}
          </div>
        )}
      </div>

      {/* Content */}
      {isLoading ? (
        <Card className="p-5">
          <div className="flex flex-col gap-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-start gap-3">
                <Skeleton className="h-8 w-8 shrink-0 rounded-full" />
                <div className="flex-1 space-y-2 py-1">
                  <Skeleton className="h-3 w-1/3" />
                  <Skeleton className="h-3 w-2/3" />
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : isError ? (
        <ErrorState
          title="Couldn't load activity"
          description="There was a problem fetching the activity feed."
          onRetry={() => void refetch()}
        />
      ) : events.length === 0 ? (
        <EmptyState
          icon={<ActivityIcon />}
          title="No activity yet"
          description="Build, deploy, and project events show up here."
        />
      ) : (
        <div className="flex flex-col gap-6">
          {groups.map((group) => (
            <section key={group.key} className="flex flex-col gap-3">
              <h2 className="text-xs font-medium uppercase tracking-wide text-slate-500">
                {group.label}
              </h2>
              <Card className="overflow-hidden p-2">
                <ul className="relative">
                  {/* Vertical timeline rail, centered under the icon badges (badge
                      center = px-2 + 16px = left-6); short of the first/last badge. */}
                  <span
                    aria-hidden
                    className="absolute bottom-6 left-6 top-6 w-px bg-slate-800"
                  />
                  {group.events.map((event) => (
                    <EventRow key={event.id} event={event} />
                  ))}
                </ul>
              </Card>
            </section>
          ))}

          {hasNextPage && (
            <div className="flex justify-center pt-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void fetchNextPage()}
                disabled={isFetchingNextPage}
                loading={isFetchingNextPage}
              >
                {isFetchingNextPage ? 'Loading…' : 'Load more'}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
