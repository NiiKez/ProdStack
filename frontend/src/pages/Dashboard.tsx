import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { GitBranch, Github, Plus, Rocket, Search } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Input,
  RelativeTime,
  Skeleton,
  StatusPill,
} from '@/components/ui';
import { useProjects } from '@/hooks/useProjects';
import { isInFlight, statusVisual, toBuildStatus } from '@/lib/status';
import { NewProjectModal } from '@/components/NewProjectModal';
import type { ProjectSummary } from '@/types/api';

const DAY_MS = 24 * 60 * 60 * 1000;

interface StatsCardProps {
  label: string;
  value: number | string;
  hint?: string | undefined;
  dotClass: string;
}

function StatsCard({ label, value, hint, dotClass }: StatsCardProps) {
  return (
    <Card className="p-5">
      <p className="flex items-center gap-2 text-xs font-medium text-slate-400">
        <span className={`h-1.5 w-1.5 rounded-full ${dotClass}`} aria-hidden />
        {label}
      </p>
      <p className="mt-3 text-3xl font-semibold tracking-tight text-slate-50">{value}</p>
      {hint && <p className="mt-1.5 text-xs text-slate-500">{hint}</p>}
    </Card>
  );
}

/** Initials from a project name, e.g. "shop-api" → "SA", "Alpha Service" → "AS". */
function deriveMonogram(name: string): string {
  const parts = name
    .trim()
    .split(/[\s\-_./]+/)
    .filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}

/** Status-driven accent strip across the top of a card (mockup: building/failed). */
function topStripClass(project: ProjectSummary): string | null {
  if (!project.latestBuild) return null;
  const tone = statusVisual[toBuildStatus(project.latestBuild.status)].tone;
  if (tone === 'building') return 'bg-amber-400';
  if (tone === 'queued') return 'bg-sky-400';
  if (tone === 'failed') return 'bg-rose-500';
  return null;
}

function ProjectCard({ project }: { project: ProjectSummary }) {
  const strip = topStripClass(project);
  return (
    <Card
      as={Link}
      to={`/projects/${project.id}`}
      interactive
      className="relative flex flex-col gap-4 overflow-hidden p-5"
    >
      {strip && <span className={`absolute inset-x-0 top-0 h-[3px] ${strip}`} aria-hidden />}

      <div className="flex items-start justify-between gap-3">
        <span
          aria-hidden
          className="grid h-10 w-10 place-items-center rounded-xl border border-slate-700/60 bg-slate-800/70 text-sm font-semibold text-accent-400"
        >
          {deriveMonogram(project.name)}
        </span>
        <div className="flex items-center gap-2">
          {project.status === 'STOPPED' && <Badge variant="warn">Stopped</Badge>}
          {project.latestBuild ? (
            <StatusPill status={project.latestBuild.status} />
          ) : (
            <Badge>No builds yet</Badge>
          )}
        </div>
      </div>

      <div className="min-w-0">
        <h3 className="truncate text-[15px] font-semibold text-slate-100">{project.name}</h3>
        <p className="mt-1 flex items-center gap-1.5 font-mono text-xs text-slate-500">
          <Github size={12} aria-hidden className="shrink-0" />
          <span className="truncate">{project.githubRepoFullName}</span>
        </p>
      </div>

      <div className="mt-auto flex items-center justify-between gap-2 border-t border-slate-800/60 pt-3 text-xs text-slate-500">
        <span className="flex min-w-0 items-center gap-1.5">
          <GitBranch size={12} aria-hidden className="shrink-0" />
          <span className="truncate font-mono">{project.branch}</span>
        </span>
        <span className="shrink-0">
          {project.activeDeployment ? (
            <>
              Deployed <RelativeTime value={project.activeDeployment.createdAt} />
            </>
          ) : (
            <>Not deployed yet</>
          )}
        </span>
      </div>
    </Card>
  );
}

function DashboardSkeleton() {
  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <Card key={i} className="flex flex-col gap-4 p-5">
          <div className="flex items-center justify-between">
            <Skeleton className="h-10 w-10 rounded-xl" />
            <Skeleton className="h-5 w-16" />
          </div>
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-3 w-3/4" />
          <Skeleton className="mt-2 h-3 w-full" />
        </Card>
      ))}
    </div>
  );
}

export default function Dashboard() {
  const [modalOpen, setModalOpen] = useState(false);
  const [query, setQuery] = useState('');
  const navigate = useNavigate();
  const { data, isLoading, isError, refetch, isFetching } = useProjects();

  const stats = useMemo(() => {
    const list = data ?? [];
    const now = Date.now();
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
    const total = list.length;
    const activeDeploys = list.filter((p) => p.activeDeployment != null).length;
    const recentBuilds = list.filter((p) => {
      if (!p.latestBuild) return false;
      const t = new Date(p.latestBuild.createdAt).getTime();
      return !Number.isNaN(t) && now - t < DAY_MS;
    }).length;
    const inFlight = list.filter((p) => isInFlight(p.latestBuild?.status)).length;
    const newThisMonth = list.filter((p) => {
      const t = new Date(p.createdAt).getTime();
      return !Number.isNaN(t) && t >= monthStart;
    }).length;
    return { total, activeDeploys, recentBuilds, inFlight, newThisMonth };
  }, [data]);

  const filtered = useMemo(() => {
    const list = data ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.githubRepoFullName.toLowerCase().includes(q) ||
        p.branch.toLowerCase().includes(q),
    );
  }, [data, query]);

  const openModal = () => setModalOpen(true);

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-50">Projects</h1>
          <p className="mt-0.5 text-sm text-slate-400">
            Connect a repo and ship to Container Apps in minutes.
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <Input
            type="search"
            aria-label="Search projects"
            placeholder="Search"
            leadingIcon={<Search />}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-44 sm:w-56"
          />
          <Button leadingIcon={<Plus size={16} />} onClick={openModal}>
            New Project
          </Button>
        </div>
      </header>

      <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatsCard
          label="Total projects"
          value={isLoading ? '—' : stats.total}
          hint={isLoading ? undefined : `${stats.newThisMonth} new this month`}
          dotClass="bg-accent-400"
        />
        <StatsCard
          label="Active deployments"
          value={isLoading ? '—' : stats.activeDeploys}
          hint={isLoading ? undefined : 'Live now'}
          dotClass="bg-emerald-400"
        />
        <StatsCard
          label="Builds (last 24h)"
          value={isLoading ? '—' : stats.recentBuilds}
          hint={isLoading ? undefined : 'In the last day'}
          dotClass="bg-amber-400"
        />
        <StatsCard
          label="In progress"
          value={isLoading ? '—' : stats.inFlight}
          hint={isLoading ? undefined : 'Building now'}
          dotClass="bg-sky-400"
        />
      </section>

      <section className="flex flex-col gap-4">
        {!isLoading && !isError && data && data.length > 0 && (
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-200">Active projects</h2>
            <span className="text-xs text-slate-500">
              {filtered.length} of {data.length}
            </span>
          </div>
        )}

        {isLoading ? (
          <DashboardSkeleton />
        ) : isError ? (
          <ErrorState
            title="Couldn't load projects"
            description="Something went wrong fetching your projects."
            onRetry={() => {
              void refetch();
            }}
            retryLabel={isFetching ? 'Retrying…' : 'Retry'}
          />
        ) : !data || data.length === 0 ? (
          <EmptyState
            icon={<Rocket />}
            title="No projects yet"
            description="Create your first project to start deploying."
            cta={
              <Button leadingIcon={<Plus size={16} />} onClick={openModal}>
                New Project
              </Button>
            }
          />
        ) : filtered.length === 0 ? (
          <Card className="p-10 text-center">
            <p className="text-sm text-slate-300">No projects match “{query}”.</p>
            <p className="mt-1 text-xs text-slate-500">Try a different name, repo, or branch.</p>
          </Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {filtered.map((p) => (
              <ProjectCard key={p.id} project={p} />
            ))}
          </div>
        )}
      </section>

      <NewProjectModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        onCreated={(p) => {
          setModalOpen(false);
          // Both real and demo creates land on the project overview; the first
          // build is started explicitly from there via "Trigger build".
          navigate(`/projects/${p.id}`);
        }}
      />
    </div>
  );
}
