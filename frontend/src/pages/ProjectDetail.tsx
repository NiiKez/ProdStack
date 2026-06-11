import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowLeft,
  BarChart3,
  Copy,
  ExternalLink,
  Github,
  GitBranch,
  Rocket,
  RotateCcw,
  Terminal,
  Trash2,
  XCircle,
} from 'lucide-react';
import {
  Avatar,
  Badge,
  Button,
  Card,
  CommitRef,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  IconButton,
  Input,
  KeyValueEditor,
  RelativeTime,
  Select,
  Skeleton,
  Spinner,
  StatusPill,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  isValidEnvKey,
  useToast,
} from '@/components/ui';
import type { EnvRow } from '@/components/ui';
import { cn } from '@/lib/cn';
import { api } from '@/lib/api';
import { buildEnvPayload, envRowsDirty, rowsFromServer } from '@/lib/envVars';
import { isInFlight } from '@/lib/status';
import { useProject } from '@/hooks/useProject';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useDeleteProject } from '@/hooks/useDeleteProject';
import { useProjectBuilds, type BuildFilters } from '@/hooks/useProjectBuilds';
import { useProjectDeployments } from '@/hooks/useProjectDeployments';
import { useProjectMetrics } from '@/hooks/useProjectMetrics';
import { useRuntimeLogs } from '@/hooks/useRuntimeLogs';
import { useRollbackDeployment } from '@/hooks/useRollbackDeployment';
import { useRebuildProject } from '@/hooks/useRebuildProject';
import { useCancelBuild } from '@/hooks/useCancelBuild';
import { MetricsChart } from '@/components/MetricsChart';
import { formatLogClock } from '@/lib/runtimeLogs';
import type { MetricKey, MetricRange } from '@/lib/metrics';
import type {
  BuildSummary,
  DeploymentListItem,
  ProjectDetail as ProjectDetailType,
  UpdateProjectInput,
  UpdateProjectResult,
} from '@/types/api';

type TabValue = 'overview' | 'builds' | 'deployments' | 'logs' | 'metrics' | 'settings';

const TAB_VALUES: ReadonlySet<TabValue> = new Set<TabValue>([
  'overview',
  'builds',
  'deployments',
  'logs',
  'metrics',
  'settings',
]);

function isTabValue(v: string | null): v is TabValue {
  return !!v && TAB_VALUES.has(v as TabValue);
}

export default function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const tabParam = searchParams.get('tab');
  const activeTab: TabValue = isTabValue(tabParam) ? tabParam : 'overview';

  const projectQuery = useProject(id);

  const handleTabChange = (value: string) => {
    if (!isTabValue(value)) return;
    const next = new URLSearchParams(searchParams);
    next.set('tab', value);
    setSearchParams(next, { replace: true });
  };

  const handleCopy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: `${label} copied`, variant: 'success' });
    } catch {
      toast({ title: `Could not copy ${label.toLowerCase()}`, variant: 'error' });
    }
  };

  if (!id) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink />
        <EmptyState
          title="Project not found"
          description="No project id was provided in the URL."
          cta={
            <Button onClick={() => navigate('/dashboard')}>Back to dashboard</Button>
          }
        />
      </div>
    );
  }

  if (projectQuery.isLoading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center text-slate-400">
        <Spinner size="lg" />
      </div>
    );
  }

  if (projectQuery.isError) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink />
        <ErrorState
          title="Couldn't load this project"
          description="Something went wrong fetching project details."
          onRetry={() => {
            void projectQuery.refetch();
          }}
        />
      </div>
    );
  }

  const project = projectQuery.data;
  if (!project) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink />
        <EmptyState
          title="Project not found"
          description="This project may have been deleted."
          cta={<Button onClick={() => navigate('/dashboard')}>Back to dashboard</Button>}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <BackLink />
      <ProjectHeaderCard project={project} onCopy={handleCopy} />

      <Tabs value={activeTab} onValueChange={handleTabChange} className="flex flex-col gap-4">
        <TabsList className="sticky top-0 z-10 -mx-1 bg-slate-950/85 px-1 backdrop-blur">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="builds">Builds</TabsTrigger>
          <TabsTrigger value="deployments">Deployments</TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
          <TabsTrigger value="metrics">Metrics</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <OverviewTab project={project} />
        </TabsContent>
        <TabsContent value="builds">
          <BuildsTab project={project} />
        </TabsContent>
        <TabsContent value="deployments">
          <DeploymentsTab project={project} />
        </TabsContent>
        <TabsContent value="logs">
          <LogsTab project={project} />
        </TabsContent>
        <TabsContent value="metrics">
          <MetricsTab project={project} />
        </TabsContent>
        <TabsContent value="settings">
          <SettingsTab project={project} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function BackLink() {
  return (
    <Link
      to="/dashboard"
      className={cn(
        'group inline-flex w-fit items-center gap-1.5 rounded-md text-sm text-slate-400',
        'transition-colors hover:text-slate-200',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950'
      )}
    >
      <ArrowLeft
        size={14}
        aria-hidden
        className="transition-transform group-hover:-translate-x-0.5"
      />
      All projects
    </Link>
  );
}

interface ProjectHeaderCardProps {
  project: ProjectDetailType;
  onCopy: (text: string, label: string) => void;
}

function ProjectHeaderCard({ project, onCopy }: ProjectHeaderCardProps) {
  return (
    <Card className="relative flex flex-col gap-5 overflow-hidden p-6">
      {/* Subtle accent wash anchoring the hero to the brand. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -right-24 -top-24 h-56 w-56 rounded-full bg-accent-400/5 blur-3xl"
      />
      <div className="relative flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          <h1 className="truncate text-2xl font-semibold tracking-tight text-slate-50">
            {project.name}
          </h1>
          <a
            href={`https://github.com/${project.githubRepoFullName}`}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex w-fit items-center gap-1.5 rounded-md font-mono text-sm text-slate-400 transition-colors hover:text-slate-200"
          >
            <Github size={14} aria-hidden className="shrink-0" />
            <span className="truncate">{project.githubRepoFullName}</span>
            <ExternalLink size={12} aria-hidden className="shrink-0 opacity-70" />
          </a>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge mono variant="accent">
            <GitBranch size={12} aria-hidden />
            {project.branch}
          </Badge>
          {project.latestBuild ? (
            <StatusPill status={project.latestBuild.status} />
          ) : (
            <Badge>No builds yet</Badge>
          )}
        </div>
      </div>

      {project.liveUrl && (
        <div className="relative flex items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 transition-colors hover:border-slate-700">
          <a
            href={project.liveUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="flex min-w-0 items-center gap-2 truncate font-mono text-xs text-slate-300 transition-colors hover:text-accent-300"
          >
            <span className="grid h-5 w-5 shrink-0 place-items-center rounded-md bg-slate-800/80 text-slate-400">
              <ExternalLink size={11} aria-hidden />
            </span>
            <span className="truncate">{project.liveUrl}</span>
          </a>
          <IconButton
            label="Copy live URL"
            size="sm"
            icon={<Copy />}
            onClick={() => {
              if (project.liveUrl) onCopy(project.liveUrl, 'Live URL');
            }}
          />
        </div>
      )}
    </Card>
  );
}

interface OverviewTabProps {
  project: ProjectDetailType;
}

function OverviewTab({ project }: OverviewTabProps) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const rebuild = useRebuildProject();
  const cancelBuild = useCancelBuild();
  const [cancelOpen, setCancelOpen] = useState(false);
  const isDemo = useCurrentUser().data?.isDemo ?? false;

  const latest = project.latestBuild;
  const active = project.activeDeployment;
  // Look up author from builds list when available (richer than latestBuild).
  const latestBuildFull: BuildSummary | undefined = latest
    ? project.builds.find((b) => b.id === latest.id)
    : undefined;
  const authorName = latestBuildFull?.commitAuthor ?? '';

  const buildInFlight = isInFlight(latest?.status);

  const handleRebuild = async () => {
    try {
      const result = await rebuild.mutateAsync(project.id);
      toast({ title: 'Build queued', variant: 'success' });
      navigate(`/projects/${project.id}/builds/${result.buildId}`);
    } catch (err) {
      const description = err instanceof Error ? err.message : '';
      toast({
        title: 'Could not start build',
        variant: 'error',
        ...(description ? { description } : {}),
      });
    }
  };

  const handleCancelLatest = async () => {
    if (!latest) return;
    try {
      const result = await cancelBuild.mutateAsync({ buildId: latest.id, projectId: project.id });
      toast({
        title: result.cancelRequested ? 'Cancelling build…' : 'Build cancelled',
        variant: 'success',
      });
      setCancelOpen(false);
    } catch (err) {
      const description = err instanceof Error ? err.message : '';
      toast({
        title: 'Could not cancel build',
        variant: 'error',
        ...(description ? { description } : {}),
      });
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Card className="flex flex-col gap-3 p-5">
          <div className="flex items-center justify-between gap-2">
            <h2 className="inline-flex items-center gap-2 text-sm font-semibold text-slate-100">
              <Rocket size={14} aria-hidden className="text-slate-500" />
              Latest build
            </h2>
            {latest ? (
              <StatusPill status={latest.status} />
            ) : (
              <Badge>No builds yet</Badge>
            )}
          </div>
          {latest ? (
            <>
              <div className="flex min-w-0 items-center gap-2 text-sm text-slate-300">
                <CommitRef sha={latest.commitSha} />
                <span className="truncate text-slate-300">{latest.commitMessage}</span>
              </div>
              <div className="flex items-center gap-2 text-xs text-slate-400">
                {authorName && (
                  <span className="inline-flex items-center gap-1.5">
                    <Avatar alt={authorName} size="sm" />
                    <span>{authorName}</span>
                  </span>
                )}
                <RelativeTime value={latest.createdAt} />
              </div>
              <div className="mt-1 flex items-center gap-3 border-t border-slate-800 pt-3">
                <Link
                  to={`/projects/${project.id}/builds/${latest.id}`}
                  className="inline-flex items-center gap-1 rounded text-xs font-medium text-accent-400 transition-colors hover:text-accent-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900"
                >
                  View logs
                </Link>
                {buildInFlight && (
                  <Button
                    variant="danger"
                    size="sm"
                    leadingIcon={<XCircle size={14} />}
                    onClick={() => setCancelOpen(true)}
                    title="Stop this running build"
                  >
                    Cancel
                  </Button>
                )}
              </div>
            </>
          ) : (
            <p className="text-sm text-slate-400">
              {isDemo
                ? 'No builds yet. Hit “Trigger build” below to deploy your first build.'
                : 'No builds yet. Push a commit to your repo to trigger the first build.'}
            </p>
          )}
        </Card>

        <Card className="flex flex-col gap-3 p-5">
          <h2 className="inline-flex items-center gap-2 text-sm font-semibold text-slate-100">
            <Rocket size={14} aria-hidden className="text-slate-500" />
            Active deployment
          </h2>
          {active ? (
            <>
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center rounded-md border border-slate-800 bg-slate-950/60 px-2 py-1 font-mono text-xs text-slate-300">
                  {active.revisionName}
                </span>
              </div>
              <div className="text-xs text-slate-400">
                Deployed <RelativeTime value={active.createdAt} />
              </div>
              {project.liveUrl && (
                <a
                  href={project.liveUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex w-fit items-center gap-1.5 rounded font-mono text-xs font-medium text-accent-400 transition-colors hover:text-accent-300"
                >
                  <ExternalLink size={12} aria-hidden className="shrink-0" />
                  <span className="truncate">{project.liveUrl}</span>
                </a>
              )}
            </>
          ) : (
            <p className="text-sm text-slate-400">No active deployment yet.</p>
          )}
        </Card>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          leadingIcon={<Rocket size={16} />}
          variant="secondary"
          disabled={buildInFlight || rebuild.isPending}
          loading={rebuild.isPending}
          title={buildInFlight ? 'A build is already running' : 'Build the latest commit on this branch'}
          onClick={() => void handleRebuild()}
        >
          Trigger build
        </Button>
        <a
          href={`https://github.com/${project.githubRepoFullName}`}
          target="_blank"
          rel="noreferrer noopener"
          className={cn(
            'inline-flex h-9 items-center gap-2 rounded-lg border border-slate-800 bg-slate-900 px-3.5 text-sm font-medium text-slate-100',
            'transition-colors hover:border-slate-700 hover:bg-slate-800',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950'
          )}
        >
          <Github size={16} aria-hidden />
          Open in GitHub
        </a>
      </div>

      <ConfirmDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title="Cancel this build?"
        description="The build will stop and be marked as cancelled."
        confirmLabel="Cancel build"
        cancelLabel="Keep building"
        variant="danger"
        loading={cancelBuild.isPending}
        onConfirm={() => void handleCancelLatest()}
      />
    </div>
  );
}

interface BuildsTabProps {
  project: ProjectDetailType;
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950',
        active
          ? 'border-accent-400/40 bg-accent-400/10 text-accent-300'
          : 'border-slate-700 bg-slate-900 text-slate-400 hover:border-slate-600 hover:text-slate-200',
      )}
    >
      {children}
    </button>
  );
}

function formatDuration(ms: number | null): string {
  if (ms == null || ms < 0) return '—';
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s}s`;
}

const STATUS_GROUPS: ReadonlyArray<{ label: string; statuses: string[] }> = [
  { label: 'Success', statuses: ['READY'] },
  { label: 'In progress', statuses: ['QUEUED', 'CLONING', 'BUILDING', 'PUSHING', 'DEPLOYING'] },
  { label: 'Failed', statuses: ['FAILED'] },
  { label: 'Cancelled', statuses: ['CANCELLED'] },
];

const RANGE_OPTIONS = [
  { value: 'all', label: 'All time' },
  { value: '24h', label: 'Last 24h' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
];

const SORT_OPTIONS = [
  { value: 'created:desc', label: 'Newest first' },
  { value: 'created:asc', label: 'Oldest first' },
  { value: 'duration:desc', label: 'Longest build' },
  { value: 'duration:asc', label: 'Shortest build' },
];

function sinceFromRange(range: string): string | undefined {
  const days = range === '24h' ? 1 : range === '7d' ? 7 : range === '30d' ? 30 : 0;
  if (days === 0) return undefined;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function BuildsTab({ project }: BuildsTabProps) {
  const [groups, setGroups] = useState<Set<string>>(new Set());
  const [range, setRange] = useState('all');
  const [sort, setSort] = useState('created:desc');
  const isDemo = useCurrentUser().data?.isDemo ?? false;

  const filters = useMemo<BuildFilters>(() => {
    const statuses = STATUS_GROUPS.filter((g) => groups.has(g.label)).flatMap((g) => g.statuses);
    const [sortField, order] = sort.split(':') as ['created' | 'duration', 'asc' | 'desc'];
    const since = sinceFromRange(range);
    return {
      ...(statuses.length > 0 ? { status: statuses } : {}),
      sort: sortField,
      order,
      ...(since ? { since } : {}),
    };
  }, [groups, range, sort]);

  const query = useProjectBuilds(project.id, filters);
  const builds = query.data?.pages.flatMap((p) => p.items) ?? [];
  const anyFilter = groups.size > 0 || range !== 'all';

  const toggleGroup = (label: string) => {
    setGroups((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {STATUS_GROUPS.map((g) => (
            <Chip key={g.label} active={groups.has(g.label)} onClick={() => toggleGroup(g.label)}>
              {g.label}
            </Chip>
          ))}
        </div>
        <div className="flex items-end gap-2">
          <Select
            label="Range"
            options={RANGE_OPTIONS}
            value={range}
            onChange={(e) => setRange(e.target.value)}
          />
          <Select
            label="Sort"
            options={SORT_OPTIONS}
            value={sort}
            onChange={(e) => setSort(e.target.value)}
          />
        </div>
      </div>

      {query.isLoading ? (
        <Card className="p-4">
          <Skeleton lines={5} />
        </Card>
      ) : query.isError ? (
        <ErrorState
          title="Couldn't load builds"
          onRetry={() => {
            void query.refetch();
          }}
        />
      ) : builds.length === 0 ? (
        <EmptyState
          title={anyFilter ? 'No builds match these filters' : 'No builds yet'}
          description={
            anyFilter
              ? 'Try clearing a filter or widening the date range.'
              : isDemo
                ? 'Hit “Trigger build” on the Overview tab to deploy your first build.'
                : 'Push a commit to your repo to trigger the first build.'
          }
        />
      ) : (
        <>
          <Card className="overflow-hidden">
            <ul className="divide-y divide-slate-800">
              {builds.map((b) => (
                <li key={b.id}>
                  <Link
                    to={`/projects/${project.id}/builds/${b.id}`}
                    className={cn(
                      'grid grid-cols-[auto_1fr_auto_auto_auto] items-center gap-3 px-4 py-3',
                      'transition-colors hover:bg-slate-800/40',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-400',
                    )}
                  >
                    <StatusPill status={b.status} />
                    <div className="flex min-w-0 items-center gap-2">
                      <CommitRef sha={b.commitSha} />
                      <span className="truncate text-sm text-slate-300">{b.commitMessage}</span>
                    </div>
                    <Badge mono variant="neutral">
                      {b.branch}
                    </Badge>
                    <span className="font-mono text-xs text-slate-500">
                      {formatDuration(b.durationMs)}
                    </span>
                    <RelativeTime value={b.startedAt ?? b.createdAt} className="text-xs" />
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
          {query.hasNextPage && (
            <div className="flex justify-center">
              <Button
                variant="secondary"
                size="sm"
                loading={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                Load more
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function DeploymentsTab({ project }: { project: ProjectDetailType }) {
  const { toast } = useToast();
  const query = useProjectDeployments(project.id);
  const rollback = useRollbackDeployment();
  const [target, setTarget] = useState<DeploymentListItem | null>(null);

  const deployments = query.data?.pages.flatMap((p) => p.items) ?? [];

  // The deployments list has no in-flight signal to poll on, but the project
  // query does poll live while a build runs. When the newest build flips from
  // in-flight → READY a fresh deployment row was just created, so refetch once
  // on that transition (otherwise the tab shows the previous Active row stale).
  const latestStatus = project.latestBuild?.status;
  const prevStatusRef = useRef<string | undefined>(latestStatus);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = latestStatus;
    // On any in-flight → terminal transition the build just finished; a READY
    // build means a fresh deployment row exists. (FAILED/CANCELLED refetch is a
    // harmless no-op — no new deployment.)
    if (prev && isInFlight(prev) && !isInFlight(latestStatus)) {
      void query.refetch();
    }
    // query.refetch is stable across renders (TanStack Query).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestStatus]);

  const handleRollback = async () => {
    if (!target) return;
    try {
      await rollback.mutateAsync({ projectId: project.id, deploymentId: target.id });
      toast({ title: `Rolling back to ${target.build.commitSha.slice(0, 7)}…`, variant: 'success' });
      setTarget(null);
    } catch (err) {
      const description = err instanceof Error ? err.message : '';
      toast({
        title: 'Rollback failed',
        variant: 'error',
        ...(description ? { description } : {}),
      });
    }
  };

  if (query.isLoading) {
    return (
      <Card className="p-4">
        <Skeleton lines={5} />
      </Card>
    );
  }
  if (query.isError) {
    return (
      <ErrorState
        title="Couldn't load deployments"
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }
  if (deployments.length === 0) {
    return (
      <EmptyState
        title="No deployments yet"
        description="Deployments appear after the first successful build."
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Table>
        <THead>
          <TR>
            <TH>Status</TH>
            <TH>Revision</TH>
            <TH>Commit</TH>
            <TH>Deployed</TH>
            <TH className="text-right">Actions</TH>
          </TR>
        </THead>
        <TBody>
          {deployments.map((d) => (
            <TR key={d.id}>
              <TD>
                {d.active ? (
                  <Badge variant="success">Active</Badge>
                ) : d.rolledBack ? (
                  <Badge variant="accent">Rolled back</Badge>
                ) : (
                  <Badge variant="neutral">Replaced</Badge>
                )}
              </TD>
              <TD>
                <span className="font-mono text-xs text-slate-400">{d.revisionName}</span>
              </TD>
              <TD>
                <div className="flex min-w-0 items-center gap-2">
                  <CommitRef sha={d.build.commitSha} />
                  <span className="max-w-[22ch] truncate text-sm text-slate-300">
                    {d.build.commitMessage}
                  </span>
                </div>
              </TD>
              <TD className="text-xs text-slate-400">
                <RelativeTime value={d.createdAt} />
              </TD>
              <TD>
                <div className="flex items-center justify-end gap-2">
                  <Link
                    to={`/projects/${project.id}/builds/${d.build.id}`}
                    className="rounded text-xs font-medium text-accent-400 transition-colors hover:text-accent-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400"
                  >
                    Logs
                  </Link>
                  {!d.active && (
                    <Button
                      variant="secondary"
                      size="sm"
                      leadingIcon={<RotateCcw size={14} />}
                      onClick={() => setTarget(d)}
                    >
                      Rollback
                    </Button>
                  )}
                </div>
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>

      {query.hasNextPage && (
        <div className="flex justify-center">
          <Button
            variant="secondary"
            size="sm"
            loading={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            Load more
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={target !== null}
        onOpenChange={(o) => {
          if (!o) setTarget(null);
        }}
        title="Roll back to this deployment?"
        description={
          target
            ? `Redeploys the image from commit ${target.build.commitSha.slice(0, 7)} to ${project.name}. Your current env vars are applied.`
            : ''
        }
        confirmLabel="Roll back"
        variant="primary"
        loading={rollback.isPending}
        onConfirm={() => void handleRollback()}
      />
    </div>
  );
}

// --- Logs tab (the running app's stdout/stderr) ----------------------------

function LogsTab({ project }: { project: ProjectDetailType }) {
  const logsQuery = useRuntimeLogs(project.id, { sinceMinutes: 15 });
  const scrollRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  const data = logsQuery.data;
  const lines = useMemo(() => data?.lines ?? [], [data]);

  // Autoscroll to the newest line unless the user has scrolled up to read.
  useEffect(() => {
    if (!autoScroll) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, autoScroll]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(nearBottom);
  };

  return (
    <Card className="flex flex-col gap-3 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="inline-flex items-center gap-2 text-sm font-semibold text-slate-100">
          <Terminal size={14} aria-hidden className="text-slate-500" />
          Runtime logs
        </h2>
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => void logsQuery.refetch()}>
            Refresh
          </Button>
          <span className="inline-flex items-center gap-1.5 text-xs text-slate-400">
            <span
              className={cn(
                'h-2 w-2 rounded-full',
                logsQuery.isFetching ? 'animate-pulse bg-emerald-400' : 'bg-slate-600',
              )}
            />
            {logsQuery.isFetching ? 'Refreshing' : 'Auto · every 8s'}
          </span>
        </div>
      </div>

      {logsQuery.isLoading ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-3/4" />
        </div>
      ) : logsQuery.isError ? (
        <ErrorState
          title="Couldn’t load logs"
          description="The runtime logs request failed. Retry, or check back in a moment."
          onRetry={() => void logsQuery.refetch()}
        />
      ) : data && !data.available ? (
        <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-400">
          {data.note ?? 'Runtime logs are unavailable for this app right now.'}
        </div>
      ) : lines.length === 0 ? (
        <p className="rounded-lg border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-400">
          No output in the last 15 minutes. A scale-to-zero app that isn’t handling requests sits
          idle — open its URL to wake it and logs will appear here.
        </p>
      ) : (
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="max-h-[60vh] overflow-auto rounded-lg border border-slate-800 bg-slate-950/70 p-3 font-mono text-xs leading-relaxed"
        >
          {lines.map((line, i) => (
            <div key={`${line.ts}-${i}`} className="flex gap-3">
              <span className="shrink-0 select-none text-slate-600">{formatLogClock(line.ts)}</span>
              <span
                className={cn(
                  'whitespace-pre-wrap break-all',
                  line.stream === 'stderr' ? 'text-rose-300' : 'text-slate-300',
                )}
              >
                {line.message}
              </span>
            </div>
          ))}
        </div>
      )}
      <p className="text-xs text-slate-400">
        Streamed from Azure Log Analytics — a short ingestion delay (~1–2 min) is normal.
      </p>
    </Card>
  );
}

// --- Metrics tab (Azure Monitor: cpu/memory/replicas/requests) -------------

const METRIC_RANGE_OPTIONS = [
  { value: '1h', label: 'Last hour' },
  { value: '6h', label: 'Last 6 hours' },
  { value: '24h', label: 'Last 24 hours' },
];

const METRIC_COLORS: Record<MetricKey, string> = {
  cpu: '#a3e635', // lime / accent
  memory: '#38bdf8', // sky
  replicas: '#fbbf24', // amber
  requests: '#34d399', // emerald
};

function MetricsTab({ project }: { project: ProjectDetailType }) {
  const [range, setRange] = useState<MetricRange>('1h');
  const metricsQuery = useProjectMetrics(project.id, range);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="inline-flex items-center gap-2 text-xs text-slate-500">
          <BarChart3 size={14} aria-hidden className="text-slate-500" />
          Resource usage from Azure Monitor · auto-refreshes every 30s
        </p>
        <Select
          leadingLabel="Range"
          options={METRIC_RANGE_OPTIONS}
          value={range}
          onChange={(e) => setRange(e.target.value as MetricRange)}
        />
      </div>

      {metricsQuery.isLoading ? (
        <div className="grid gap-4 md:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <Card key={i} className="p-5">
              <Skeleton className="h-40 w-full" />
            </Card>
          ))}
        </div>
      ) : metricsQuery.isError ? (
        <ErrorState
          title="Couldn’t load metrics"
          description="Azure Monitor didn’t return data for this app. It may be idle (scaled to zero) or metrics aren’t available yet."
          onRetry={() => void metricsQuery.refetch()}
        />
      ) : metricsQuery.data && !metricsQuery.data.available ? (
        <Card className="p-6 text-sm text-slate-400">
          {metricsQuery.data.note ?? 'Metrics are unavailable for this app right now.'}
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {(metricsQuery.data?.series ?? []).map((s) => (
            <Card key={s.key} className="p-5">
              <MetricsChart series={s} color={METRIC_COLORS[s.key]} />
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

interface SettingsTabProps {
  project: ProjectDetailType;
}

function useUpdateProject(id: string) {
  const qc = useQueryClient();
  return useMutation<UpdateProjectResult, Error, UpdateProjectInput, { prev?: ProjectDetailType }>({
    mutationFn: (input) =>
      api<UpdateProjectResult>(`/api/projects/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    // Optimistic for `name` / `branch` per the spec. Env-var edits go through
    // the same mutation but are NOT mirrored optimistically — the server
    // re-reads + re-serializes them, so the refetch on settle is the source of
    // truth (and `SettingsTab` re-syncs its local rows from it).
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: ['project', id] });
      const prev = qc.getQueryData<ProjectDetailType>(['project', id]);
      if (prev) {
        qc.setQueryData<ProjectDetailType>(['project', id], {
          ...prev,
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.branch !== undefined ? { branch: input.branch } : {}),
          ...(input.autoDeploy !== undefined ? { autoDeploy: input.autoDeploy } : {}),
        });
      }
      return prev ? { prev } : {};
    },
    onError: (_err, _input, ctx) => {
      if (ctx?.prev) qc.setQueryData(['project', id], ctx.prev);
    },
    onSettled: (_data, _err, input) => {
      qc.invalidateQueries({ queryKey: ['project', id] });
      qc.invalidateQueries({ queryKey: ['projects'] });
      // Only an env-var save can trigger a config-only redeploy server-side (new
      // Deployment + activity row). A name/branch/autoDeploy edit can't, so don't
      // refetch the deployment/activity lists it didn't touch.
      if (input.envVars !== undefined && input.envVars !== null) {
        qc.invalidateQueries({ queryKey: ['project-deployments', id] });
        qc.invalidateQueries({ queryKey: ['deployments'] });
        qc.invalidateQueries({ queryKey: ['activity'] });
      }
    },
  });
}

function SettingsTab({ project }: SettingsTabProps) {
  const navigate = useNavigate();
  const { toast } = useToast();

  const [name, setName] = useState(project.name);
  const [branch, setBranch] = useState(project.branch);
  const [autoDeploy, setAutoDeploy] = useState(project.autoDeploy);
  const [deleteInput, setDeleteInput] = useState('');

  // Re-sync when the project data updates from elsewhere.
  useEffect(() => {
    setName(project.name);
    setBranch(project.branch);
    setAutoDeploy(project.autoDeploy);
  }, [project.name, project.branch, project.autoDeploy]);

  // Env vars: seed masked rows from the server (values are write-only — the
  // server sends only {key,hasValue}, so a stored secret shows a "(set)"
  // placeholder until the user types a replacement). Re-sync only when the
  // saved content actually changes (keyed on the serialized list) so a
  // background refetch doesn't clobber unsaved edits.
  const savedEnvKey = JSON.stringify(project.envVars ?? []);
  const [envVars, setEnvVars] = useState<EnvRow[]>(() => rowsFromServer(project.envVars));
  useEffect(() => {
    setEnvVars(rowsFromServer(project.envVars));
    // Intentionally keyed on `savedEnvKey` (the serialized content), not the
    // `project.envVars` array reference: refetches return a fresh array each
    // time and would otherwise wipe in-progress edits on every poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedEnvKey]);

  const updateProject = useUpdateProject(project.id);
  const deleteProject = useDeleteProject();

  const dirty =
    name !== project.name || branch !== project.branch || autoDeploy !== project.autoDeploy;
  const canSave = dirty && name.trim().length > 0 && branch.trim().length > 0;

  const envDirty = envRowsDirty(envVars, project.envVars);
  const envError = useMemo<string | null>(() => {
    const seen = new Set<string>();
    for (const row of envVars) {
      if (row.key.trim() === '') return 'Every variable needs a name.';
      if (!isValidEnvKey(row.key)) return `Invalid key "${row.key}" — use A–Z, 0–9, _.`;
      if (seen.has(row.key)) return `Duplicate key "${row.key}".`;
      seen.add(row.key);
      // Reject an empty value for any new OR edited row: a new key has nothing
      // to save, and clearing a stored secret to "" would silently destroy it.
      // The backend enforces the same rule (ENV_VALUE_REQUIRED); to actually
      // remove a variable, delete the row.
      if ((row.edited || !row.stored) && row.value === '') {
        return `Value can't be empty for "${row.key}" — remove the row to delete it.`;
      }
    }
    return null;
  }, [envVars]);
  const canSaveEnv = envDirty && envError === null;

  const handleSaveEnv = async () => {
    if (!canSaveEnv) return;
    try {
      // Write-only contract: send a value only for new/edited rows; omit it for
      // untouched stored rows so the backend keeps the existing secret.
      const result = await updateProject.mutateAsync({ envVars: buildEnvPayload(envVars) });
      // Re-seed the editor from the masked server result so every row resets to
      // {stored:true, edited:false, value:''} and the form clears its dirty
      // state. Without this a value-only rotation leaves the editor permanently
      // "dirty": the masked payload ({key,hasValue}) is byte-identical before and
      // after, so the savedEnvKey-keyed re-sync effect never fires.
      setEnvVars(rowsFromServer(result.envVars));
      const redeploy = result.redeploy;
      if (redeploy?.redeployed) {
        toast({
          title: 'Environment variables saved — redeploying with your latest image.',
          variant: 'success',
        });
      } else if (redeploy?.reason === 'NO_ACTIVE_DEPLOYMENT') {
        toast({ title: "Saved. They'll apply on your first deploy.", variant: 'success' });
      } else if (redeploy?.reason === 'BUILD_IN_PROGRESS') {
        toast({ title: 'Saved. Your in-progress build will pick them up.', variant: 'success' });
      } else if (redeploy?.reason === 'NO_IMAGE') {
        toast({ title: "Saved. They'll apply on your next successful build.", variant: 'success' });
      } else if (redeploy?.reason === 'REDEPLOY_FAILED') {
        toast({
          title: 'Saved, but the redeploy failed. Push a commit or try again.',
          variant: 'error',
        });
      } else {
        toast({ title: 'Environment variables saved.', variant: 'success' });
      }
    } catch (err) {
      const description = err instanceof Error ? err.message : '';
      toast({
        title: 'Could not save environment variables.',
        variant: 'error',
        ...(description ? { description } : {}),
      });
    }
  };

  const handleSave = async () => {
    if (!canSave) return;
    const patch: UpdateProjectInput = {};
    if (name !== project.name) patch.name = name.trim();
    if (branch !== project.branch) patch.branch = branch.trim();
    if (autoDeploy !== project.autoDeploy) patch.autoDeploy = autoDeploy;
    try {
      await updateProject.mutateAsync(patch);
      toast({ title: 'Project settings saved.', variant: 'success' });
    } catch (err) {
      const description = err instanceof Error ? err.message : '';
      toast({
        title: 'Could not save settings.',
        variant: 'error',
        ...(description ? { description } : {}),
      });
    }
  };

  const handleDelete = async () => {
    if (deleteInput !== project.name) return;
    try {
      await deleteProject.mutateAsync(project.id);
      toast({ title: `Project "${project.name}" deleted.`, variant: 'success' });
      navigate('/dashboard');
    } catch (err) {
      const description = err instanceof Error ? err.message : '';
      toast({
        title: 'Could not delete project.',
        variant: 'error',
        ...(description ? { description } : {}),
      });
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-3 p-5">
        <h2 className="inline-flex items-center gap-2 text-sm font-semibold text-slate-100">
          <Github size={14} aria-hidden className="text-slate-500" />
          GitHub repo
        </h2>
        <a
          href={`https://github.com/${project.githubRepoFullName}`}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex w-fit items-center gap-1.5 rounded-md border border-slate-800 bg-slate-950/60 px-3 py-2 font-mono text-sm text-slate-300 transition-colors hover:border-slate-700 hover:text-accent-300"
        >
          <Github size={14} aria-hidden className="shrink-0" />
          {project.githubRepoFullName}
          <ExternalLink size={12} aria-hidden className="shrink-0 opacity-70" />
        </a>
        <p className="text-xs text-slate-500">
          Repo connection is read-only. To switch repos, create a new project.
        </p>
      </Card>

      <Card className="flex flex-col gap-4 p-5">
        <h2 className="text-sm font-semibold text-slate-100">Project details</h2>
        <Input
          label="Project name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="off"
        />
        <Input
          label="Branch"
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          autoComplete="off"
        />
        <div className="flex items-center justify-between gap-4 rounded-lg border border-slate-800 bg-slate-950/40 p-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-medium text-slate-200">Auto-deploy on push</span>
            <span className="text-xs text-slate-500">
              Build &amp; deploy automatically on a push to{' '}
              <span className="font-mono text-slate-400">{branch || project.branch}</span>. Off =
              deploy manually with “Trigger build”.
            </span>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={autoDeploy}
            aria-label="Auto-deploy on push"
            onClick={() => setAutoDeploy((v) => !v)}
            className={cn(
              'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900',
              autoDeploy ? 'border-accent-500 bg-accent-500/80' : 'border-slate-700 bg-slate-800',
            )}
          >
            <span
              className={cn(
                'inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform',
                autoDeploy ? 'translate-x-6' : 'translate-x-1',
              )}
            />
          </button>
        </div>
        <div className="flex items-center justify-end">
          <Button
            onClick={() => void handleSave()}
            disabled={!canSave}
            loading={updateProject.isPending}
          >
            Save changes
          </Button>
        </div>
      </Card>

      <Card className="flex flex-col gap-4 p-5">
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-semibold text-slate-100">Environment variables</h2>
          <p className="text-xs text-slate-500">
            Stored encrypted and injected as Container App secrets. Saving redeploys your
            app with the new values (using your latest successful image).
          </p>
          <p className="text-xs text-slate-500">
            For security, saved values are write-only — they&apos;re hidden and can&apos;t be
            shown again. To change one, type over its field to replace it; use the trash icon
            to remove it.
          </p>
        </div>
        <KeyValueEditor value={envVars} onChange={setEnvVars} disabled={updateProject.isPending} />
        {envError && <p className="text-xs text-rose-400">{envError}</p>}
        <div className="flex items-center justify-end">
          <Button
            onClick={() => void handleSaveEnv()}
            disabled={!canSaveEnv}
            loading={updateProject.isPending}
          >
            Save variables
          </Button>
        </div>
      </Card>

      <Card className="flex flex-col gap-3 border-rose-500/30 bg-rose-500/[0.03] p-5">
        <h2 className="inline-flex items-center gap-2 text-sm font-semibold text-rose-300">
          <AlertTriangle size={14} aria-hidden />
          Danger zone
        </h2>
        <p className="text-sm text-slate-400">
          Deleting a project removes its Container App, builds, and deployments. This cannot
          be undone.
        </p>
        <Input
          label={`Type "${project.name}" to confirm`}
          value={deleteInput}
          onChange={(e) => setDeleteInput(e.target.value)}
          placeholder={project.name}
          autoComplete="off"
        />
        <div className="flex items-center justify-end">
          <Button
            variant="danger"
            leadingIcon={<Trash2 size={16} />}
            disabled={deleteInput !== project.name}
            loading={deleteProject.isPending}
            onClick={() => void handleDelete()}
          >
            Delete project
          </Button>
        </div>
      </Card>
    </div>
  );
}
