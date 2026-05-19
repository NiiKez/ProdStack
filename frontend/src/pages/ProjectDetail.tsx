import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Copy,
  ExternalLink,
  Github,
  GitBranch,
  Rocket,
  Trash2,
} from 'lucide-react';
import {
  Avatar,
  Badge,
  Button,
  Card,
  CommitRef,
  EmptyState,
  ErrorState,
  IconButton,
  Input,
  RelativeTime,
  Spinner,
  StatusPill,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useToast,
} from '@/components/ui';
import { cn } from '@/lib/cn';
import { api } from '@/lib/api';
import { useProject } from '@/hooks/useProject';
import { useDeleteProject } from '@/hooks/useDeleteProject';
import type {
  BuildSummary,
  ProjectDetail as ProjectDetailType,
  UpdateProjectInput,
} from '@/types/api';

type TabValue = 'overview' | 'builds' | 'deployments' | 'settings';

const TAB_VALUES: ReadonlySet<TabValue> = new Set<TabValue>([
  'overview',
  'builds',
  'deployments',
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
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <OverviewTab project={project} />
        </TabsContent>
        <TabsContent value="builds">
          <BuildsTab project={project} />
        </TabsContent>
        <TabsContent value="deployments">
          <DeploymentsTab />
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
        'inline-flex w-fit items-center gap-1.5 text-sm text-slate-400',
        'hover:text-slate-200 focus-visible:outline-none focus-visible:ring-2',
        'focus-visible:ring-indigo-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950 rounded-md'
      )}
    >
      <ArrowLeft size={14} aria-hidden />
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
    <Card className="flex flex-col gap-4 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold text-slate-100">{project.name}</h1>
          <a
            href={`https://github.com/${project.githubRepoFullName}`}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1.5 text-sm text-slate-400 hover:text-slate-200"
          >
            <Github size={14} aria-hidden />
            <span>{project.githubRepoFullName}</span>
            <ExternalLink size={12} aria-hidden />
          </a>
        </div>
        <div className="flex items-center gap-2">
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
        <div className="flex items-center justify-between gap-2 rounded-md border border-slate-800 bg-slate-950/40 px-3 py-2">
          <a
            href={project.liveUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="flex min-w-0 items-center gap-1.5 truncate font-mono text-xs text-slate-300 hover:text-indigo-300"
          >
            <ExternalLink size={12} aria-hidden className="shrink-0" />
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
  const latest = project.latestBuild;
  const active = project.activeDeployment;
  // Look up author from builds list when available (richer than latestBuild).
  const latestBuildFull: BuildSummary | undefined = latest
    ? project.builds.find((b) => b.id === latest.id)
    : undefined;
  const authorName = latestBuildFull?.commitAuthor ?? '';

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Card className="flex flex-col gap-3 p-5">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-slate-200">Latest build</h2>
            {latest ? (
              <StatusPill status={latest.status} />
            ) : (
              <Badge>No builds yet</Badge>
            )}
          </div>
          {latest ? (
            <>
              <div className="flex items-center gap-2 text-sm text-slate-300">
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
              <div>
                <Link
                  to={`/projects/${project.id}/builds/${latest.id}`}
                  className="inline-flex items-center gap-1 text-xs font-medium text-indigo-300 hover:text-indigo-200"
                >
                  View logs
                </Link>
              </div>
            </>
          ) : (
            <p className="text-sm text-slate-400">
              No builds yet. Push a commit to your repo to trigger the first build.
            </p>
          )}
        </Card>

        <Card className="flex flex-col gap-3 p-5">
          <h2 className="text-sm font-semibold text-slate-200">Active deployment</h2>
          {active ? (
            <>
              <div className="flex items-center gap-2 text-sm">
                <span className="font-mono text-xs text-slate-300">
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
                  className="inline-flex w-fit items-center gap-1 text-xs font-medium text-indigo-300 hover:text-indigo-200"
                >
                  <ExternalLink size={12} aria-hidden />
                  {project.liveUrl}
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
          disabled
          title="Available after first push"
        >
          Trigger build
        </Button>
        <a
          href={`https://github.com/${project.githubRepoFullName}`}
          target="_blank"
          rel="noreferrer noopener"
          className={cn(
            'inline-flex h-9 items-center gap-2 rounded-lg border border-slate-800 bg-slate-900 px-3.5 text-sm font-medium text-slate-100',
            'hover:bg-slate-800 hover:border-slate-700',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950'
          )}
        >
          <Github size={16} aria-hidden />
          Open in GitHub
        </a>
      </div>
    </div>
  );
}

interface BuildsTabProps {
  project: ProjectDetailType;
}

function BuildsTab({ project }: BuildsTabProps) {
  if (project.builds.length === 0) {
    return (
      <EmptyState
        title="No builds yet"
        description="Push a commit to your repo to trigger the first build."
      />
    );
  }

  return (
    <Card className="overflow-hidden">
      <ul className="divide-y divide-slate-800">
        {project.builds.map((b) => (
          <li key={b.id}>
            <Link
              to={`/projects/${project.id}/builds/${b.id}`}
              className={cn(
                'grid grid-cols-[auto_1fr_auto_auto] items-center gap-3 px-4 py-3',
                'hover:bg-slate-800/40 transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-inset'
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
              <RelativeTime value={b.startedAt ?? b.createdAt} className="text-xs" />
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function DeploymentsTab() {
  return (
    <EmptyState
      title="No deployments yet"
      description="Deployments appear after the first successful build."
    />
  );
}

interface SettingsTabProps {
  project: ProjectDetailType;
}

function useUpdateProject(id: string) {
  const qc = useQueryClient();
  return useMutation<ProjectDetailType, Error, UpdateProjectInput, { prev?: ProjectDetailType }>({
    mutationFn: (input) =>
      api<ProjectDetailType>(`/api/projects/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    // Optimistic for `name` / `branch` per the spec. Env-var edits will land
    // in M5 — when they do, skip the optimistic mirror for that path since
    // the server-side redeploy is the source of truth there.
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: ['project', id] });
      const prev = qc.getQueryData<ProjectDetailType>(['project', id]);
      if (prev) {
        qc.setQueryData<ProjectDetailType>(['project', id], {
          ...prev,
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.branch !== undefined ? { branch: input.branch } : {}),
        });
      }
      return prev ? { prev } : {};
    },
    onError: (_err, _input, ctx) => {
      if (ctx?.prev) qc.setQueryData(['project', id], ctx.prev);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['project', id] });
      qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

function SettingsTab({ project }: SettingsTabProps) {
  const navigate = useNavigate();
  const { toast } = useToast();

  const [name, setName] = useState(project.name);
  const [branch, setBranch] = useState(project.branch);
  const [deleteInput, setDeleteInput] = useState('');

  // Re-sync when the project data updates from elsewhere.
  useEffect(() => {
    setName(project.name);
    setBranch(project.branch);
  }, [project.name, project.branch]);

  const updateProject = useUpdateProject(project.id);
  const deleteProject = useDeleteProject();

  const dirty = name !== project.name || branch !== project.branch;
  const canSave = dirty && name.trim().length > 0 && branch.trim().length > 0;

  const handleSave = async () => {
    if (!canSave) return;
    const patch: UpdateProjectInput = {};
    if (name !== project.name) patch.name = name.trim();
    if (branch !== project.branch) patch.branch = branch.trim();
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
        <h2 className="text-sm font-semibold text-slate-200">GitHub repo</h2>
        <a
          href={`https://github.com/${project.githubRepoFullName}`}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex w-fit items-center gap-1.5 font-mono text-sm text-slate-300 hover:text-indigo-300"
        >
          <Github size={14} aria-hidden />
          {project.githubRepoFullName}
          <ExternalLink size={12} aria-hidden />
        </a>
        <p className="text-xs text-slate-500">
          Repo connection is read-only. To switch repos, create a new project.
        </p>
      </Card>

      <Card className="flex flex-col gap-4 p-5">
        <h2 className="text-sm font-semibold text-slate-200">Project details</h2>
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

      <Card className="flex flex-col gap-3 p-5">
        <h2 className="text-sm font-semibold text-slate-200">Environment variables</h2>
        <EmptyState
          title="Coming soon"
          description="Environment variables ship in M5."
        />
      </Card>

      <Card className="flex flex-col gap-3 border-rose-500/30 p-5">
        <h2 className="text-sm font-semibold text-rose-300">Danger zone</h2>
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
