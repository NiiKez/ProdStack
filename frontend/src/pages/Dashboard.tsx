import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Copy, ExternalLink, Github, Plus, Rocket } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  IconButton,
  RelativeTime,
  Skeleton,
  StatusPill,
  useToast,
} from '@/components/ui';
import { cn } from '@/lib/cn';
import { useProjects } from '@/hooks/useProjects';
import { NewProjectModal } from '@/components/NewProjectModal';
import type { ProjectSummary } from '@/types/api';

const DAY_MS = 24 * 60 * 60 * 1000;

interface StatsCardProps {
  label: string;
  value: number | string;
  hint?: string;
}

function StatsCard({ label, value, hint }: StatsCardProps) {
  return (
    <Card className="p-5">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-slate-100">{value}</p>
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </Card>
  );
}

interface ProjectCardProps {
  project: ProjectSummary;
  onCopyUrl: (url: string) => void;
}

function ProjectCard({ project, onCopyUrl }: ProjectCardProps) {
  return (
    <Card
      as={Link}
      to={`/projects/${project.id}`}
      interactive
      className="flex flex-col gap-3 p-5"
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-lg font-semibold text-slate-100">{project.name}</h3>
        {project.latestBuild ? (
          <StatusPill status={project.latestBuild.status} />
        ) : (
          <Badge>No builds yet</Badge>
        )}
      </div>

      <div className="flex items-center gap-1.5 text-xs text-slate-400">
        <Github size={14} aria-hidden />
        <span className="truncate">{project.githubRepoFullName}</span>
      </div>

      <div className="flex items-center gap-2">
        <Badge mono variant="accent">
          {project.branch}
        </Badge>
        <span className="text-xs text-slate-500">
          {project.activeDeployment ? (
            <>
              Deployed <RelativeTime value={project.activeDeployment.createdAt} />
            </>
          ) : (
            <>Not deployed yet</>
          )}
        </span>
      </div>

      {project.liveUrl ? (
        <div
          className="mt-auto flex items-center justify-between gap-2 rounded-md border border-slate-800 bg-slate-950/40 px-2.5 py-1.5"
          onClick={(e) => e.preventDefault()}
        >
          <a
            href={project.liveUrl}
            target="_blank"
            rel="noreferrer noopener"
            onClick={(e) => e.stopPropagation()}
            className="flex min-w-0 items-center gap-1.5 truncate font-mono text-xs text-slate-300 hover:text-indigo-300"
          >
            <ExternalLink size={12} aria-hidden className="shrink-0" />
            <span className="truncate">{project.liveUrl}</span>
          </a>
          <IconButton
            label="Copy live URL"
            size="sm"
            icon={<Copy />}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (project.liveUrl) onCopyUrl(project.liveUrl);
            }}
          />
        </div>
      ) : (
        <div className="mt-auto text-xs text-slate-500">No live URL yet</div>
      )}
    </Card>
  );
}

function DashboardSkeleton() {
  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <Card key={i} className="flex flex-col gap-3 p-5">
          <Skeleton className="h-5 w-1/2" />
          <Skeleton className="h-3 w-3/4" />
          <Skeleton className="h-3 w-1/3" />
          <Skeleton className="mt-2 h-8 w-full" />
        </Card>
      ))}
    </div>
  );
}

export default function Dashboard() {
  const [modalOpen, setModalOpen] = useState(false);
  const navigate = useNavigate();
  const { toast } = useToast();
  const { data, isLoading, isError, refetch, isFetching } = useProjects();

  const stats = useMemo(() => {
    const list = data ?? [];
    const now = Date.now();
    const total = list.length;
    const activeDeploys = list.filter((p) => p.activeDeployment != null).length;
    const recentBuilds = list.filter((p) => {
      if (!p.latestBuild) return false;
      const t = new Date(p.latestBuild.createdAt).getTime();
      return !Number.isNaN(t) && now - t < DAY_MS;
    }).length;
    return { total, activeDeploys, recentBuilds };
  }, [data]);

  const handleCopyUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast({ title: 'Live URL copied', variant: 'success' });
    } catch {
      toast({ title: 'Could not copy URL', variant: 'error' });
    }
  };

  const openModal = () => setModalOpen(true);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-100">Projects</h1>
          <p className="text-sm text-slate-400">
            Connect a repo and ship to Container Apps in minutes.
          </p>
        </div>
        <Button leadingIcon={<Plus size={16} />} onClick={openModal}>
          New Project
        </Button>
      </header>

      <section className={cn('grid gap-4 md:grid-cols-3')}>
        <StatsCard label="Total projects" value={isLoading ? '—' : stats.total} />
        <StatsCard
          label="Active deployments"
          value={isLoading ? '—' : stats.activeDeploys}
        />
        <StatsCard
          label="Builds (last 24h)"
          value={isLoading ? '—' : stats.recentBuilds}
        />
      </section>

      <section>
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
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {data.map((p) => (
              <ProjectCard key={p.id} project={p} onCopyUrl={handleCopyUrl} />
            ))}
          </div>
        )}
      </section>

      <NewProjectModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        onCreated={(p) => {
          setModalOpen(false);
          navigate(`/projects/${p.id}`);
        }}
      />
    </div>
  );
}
