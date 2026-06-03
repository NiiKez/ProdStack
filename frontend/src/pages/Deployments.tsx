import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Rocket, RotateCcw, ScrollText } from 'lucide-react';
import {
  Avatar,
  Badge,
  Button,
  CommitRef,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  RelativeTime,
  Skeleton,
  Spinner,
  StatusPill,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  useToast,
} from '@/components/ui';
import { cn } from '@/lib/cn';
import { useDeployments, type DeploymentFilters } from '@/hooks/useDeployments';
import { useProjects } from '@/hooks/useProjects';
import { useRollbackDeployment } from '@/hooks/useRollbackDeployment';
import { usePageTitle } from '@/hooks/usePageTitle';
import type { CrossProjectDeployment } from '@/types/api';

interface ChipProps {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}

/** A toggleable filter pill. Accent tint when active, muted otherwise. */
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
          : 'border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-600',
      )}
    >
      {children}
    </button>
  );
}

/** Toggle a value's membership in a string-array filter (returns a new array). */
function toggle(list: string[] | undefined, value: string): string[] {
  const current = list ?? [];
  return current.includes(value)
    ? current.filter((v) => v !== value)
    : [...current, value];
}

export default function Deployments() {
  usePageTitle('Deployments — ProdStack');

  const [filters, setFilters] = useState<DeploymentFilters>({});
  const [target, setTarget] = useState<CrossProjectDeployment | null>(null);

  const { toast } = useToast();
  const projectsQuery = useProjects();
  const rollback = useRollbackDeployment();
  const {
    data,
    isLoading,
    isError,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useDeployments(filters);

  const deployments = data?.pages.flatMap((p) => p.items) ?? [];
  const projects = projectsQuery.data ?? [];

  const projectFilter = filters.projectId ?? [];

  const toggleProject = (value: string) =>
    setFilters((f) => ({ ...f, projectId: toggle(f.projectId, value) }));
  const toggleActiveOnly = () =>
    setFilters((f) => ({ ...f, activeOnly: !f.activeOnly }));

  const handleConfirmRollback = async () => {
    if (!target) return;
    const projectName = target.project.name;
    try {
      await rollback.mutateAsync({
        projectId: target.project.id,
        deploymentId: target.id,
      });
      toast({ title: `Rolling back ${projectName}…`, variant: 'success' });
      setTarget(null);
    } catch (err) {
      const description = err instanceof Error ? err.message : '';
      toast({
        title: 'Rollback failed.',
        variant: 'error',
        ...(description ? { description } : {}),
      });
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-50">Deployments</h1>
        <p className="text-sm text-slate-400">
          Every deployment across your projects, newest first.
        </p>
      </header>

      <FilterBar
        projectFilter={projectFilter}
        activeOnly={filters.activeOnly ?? false}
        projects={projects}
        onToggleProject={toggleProject}
        onToggleActiveOnly={toggleActiveOnly}
      />

      {isLoading ? (
        <DeploymentsSkeleton />
      ) : isError ? (
        <ErrorState
          title="Couldn't load deployments"
          description="Something went wrong fetching your deployments."
          onRetry={() => void refetch()}
        />
      ) : deployments.length === 0 ? (
        <EmptyState
          icon={<Rocket />}
          title="No deployments yet"
          description="Deployments appear after your first successful build."
        />
      ) : (
        <>
          <DeploymentsTable
            deployments={deployments}
            onRollback={(d) => setTarget(d)}
          />

          {hasNextPage && (
            <div className="flex justify-center">
              <Button
                variant="secondary"
                onClick={() => void fetchNextPage()}
                disabled={isFetchingNextPage}
              >
                {isFetchingNextPage ? <Spinner size="sm" /> : 'Load more'}
              </Button>
            </div>
          )}
        </>
      )}

      <ConfirmDialog
        open={target !== null}
        onOpenChange={(open) => {
          if (!open) setTarget(null);
        }}
        title="Roll back deployment?"
        description={
          target ? (
            <span>
              Roll back <span className="font-medium text-slate-200">{target.project.name}</span>{' '}
              to commit{' '}
              <span className="font-mono text-slate-200">
                {target.build.commitSha.slice(0, 7)}
              </span>
              . This redeploys that image as the live revision.
            </span>
          ) : undefined
        }
        variant="primary"
        confirmLabel="Roll back"
        loading={rollback.isPending}
        onConfirm={() => void handleConfirmRollback()}
      />
    </div>
  );
}

interface FilterBarProps {
  projectFilter: string[];
  activeOnly: boolean;
  projects: Array<{ id: string; name: string }>;
  onToggleProject: (value: string) => void;
  onToggleActiveOnly: () => void;
}

function FilterBar({
  projectFilter,
  activeOnly,
  projects,
  onToggleProject,
  onToggleActiveOnly,
}: FilterBarProps) {
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
      {/* Deployments only ever reference successful (READY) builds, so a build-
          status filter would offer dead options; the meaningful toggle is
          whether to show only the currently-live deployment per project. */}
      <FilterRow label="Show">
        <Chip active={activeOnly} onClick={onToggleActiveOnly}>
          Active only
        </Chip>
      </FilterRow>

      {projects.length > 0 && (
        <FilterRow label="Project">
          {projects.map((project) => (
            <Chip
              key={project.id}
              active={projectFilter.includes(project.id)}
              onClick={() => onToggleProject(project.id)}
            >
              {project.name}
            </Chip>
          ))}
        </FilterRow>
      )}
    </div>
  );
}

function FilterRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-16 shrink-0 text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </span>
      {children}
    </div>
  );
}

interface DeploymentsTableProps {
  deployments: CrossProjectDeployment[];
  onRollback: (d: CrossProjectDeployment) => void;
}

function DeploymentsTable({ deployments, onRollback }: DeploymentsTableProps) {
  return (
    <Table>
      <THead>
        <TR>
          <TH>Project</TH>
          <TH>Status</TH>
          <TH>Revision</TH>
          <TH>Commit</TH>
          <TH>Author</TH>
          <TH>Deployed</TH>
          <TH>Active</TH>
          <TH className="text-right">Actions</TH>
        </TR>
      </THead>
      <TBody>
        {deployments.map((d) => (
          <TR key={d.id}>
            <TD>
              <Link
                to={`/projects/${d.project.id}`}
                className={cn(
                  'font-medium text-slate-100 hover:text-accent-300 transition-colors',
                  'rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400',
                )}
              >
                {d.project.name}
              </Link>
            </TD>
            <TD>
              <StatusPill status={d.build.status} />
            </TD>
            <TD>
              <span
                className="block max-w-[12rem] truncate font-mono text-xs text-slate-400"
                title={d.revisionName}
              >
                {d.revisionName}
              </span>
            </TD>
            <TD>
              <div className="flex min-w-0 items-center gap-2">
                <CommitRef sha={d.build.commitSha} />
                <span
                  className="max-w-[16rem] truncate text-sm text-slate-300"
                  title={d.build.commitMessage}
                >
                  {d.build.commitMessage}
                </span>
              </div>
            </TD>
            <TD>
              <span className="inline-flex items-center gap-1.5 text-sm text-slate-300">
                <Avatar alt={d.build.commitAuthor} size="sm" />
                <span className="truncate">{d.build.commitAuthor}</span>
              </span>
            </TD>
            <TD>
              <RelativeTime value={d.createdAt} className="text-xs text-slate-400" />
            </TD>
            <TD>
              {d.active ? (
                <Badge variant="success">Active</Badge>
              ) : d.rolledBack ? (
                <Badge variant="accent">Rolled back</Badge>
              ) : null}
            </TD>
            <TD>
              <div className="flex items-center justify-end gap-2">
                <Link
                  to={`/projects/${d.project.id}/builds/${d.build.id}`}
                  className={cn(
                    'inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium',
                    'text-slate-400 hover:bg-slate-800/60 hover:text-slate-100 transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400',
                  )}
                >
                  <ScrollText size={13} aria-hidden />
                  View logs
                </Link>
                {!d.active && (
                  <Button
                    variant="ghost"
                    size="sm"
                    leadingIcon={<RotateCcw size={13} />}
                    onClick={() => onRollback(d)}
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
  );
}

function DeploymentsSkeleton() {
  const rows = [0, 1, 2, 3, 4];
  return (
    <Table>
      <THead>
        <TR>
          <TH>Project</TH>
          <TH>Status</TH>
          <TH>Revision</TH>
          <TH>Commit</TH>
          <TH>Author</TH>
          <TH>Deployed</TH>
          <TH>Active</TH>
          <TH className="text-right">Actions</TH>
        </TR>
      </THead>
      <TBody>
        {rows.map((i) => (
          <TR key={i}>
            <TD>
              <Skeleton className="h-4 w-24" />
            </TD>
            <TD>
              <Skeleton className="h-5 w-16 rounded-full" />
            </TD>
            <TD>
              <Skeleton className="h-4 w-28" />
            </TD>
            <TD>
              <Skeleton className="h-4 w-40" />
            </TD>
            <TD>
              <Skeleton className="h-4 w-20" />
            </TD>
            <TD>
              <Skeleton className="h-4 w-16" />
            </TD>
            <TD>
              <Skeleton className="h-5 w-14 rounded-md" />
            </TD>
            <TD>
              <div className="flex justify-end">
                <Skeleton className="h-4 w-16" />
              </div>
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}
