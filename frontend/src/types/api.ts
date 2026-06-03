import type { BuildStatus } from '@/lib/status';

export interface ProjectLatestBuild {
  id: string;
  status: BuildStatus;
  commitSha: string;
  commitMessage: string;
  createdAt: string;
}

export interface ProjectActiveDeployment {
  id: string;
  revisionName: string;
  createdAt: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  slug: string;
  githubRepoFullName: string;
  branch: string;
  liveUrl: string | null;
  containerAppName: string;
  /** When false, a `git push` no longer auto-builds — deploy manually instead. */
  autoDeploy: boolean;
  createdAt: string;
  updatedAt: string;
  latestBuild: ProjectLatestBuild | null;
  activeDeployment: ProjectActiveDeployment | null;
}

export interface BuildSummary {
  id: string;
  status: BuildStatus;
  commitSha: string;
  commitMessage: string;
  commitAuthor: string;
  branch: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  createdAt: string;
}

export interface ProjectDetail extends ProjectSummary {
  builds: BuildSummary[];
  /** Present on `GET /api/projects/:id`; decrypted key/value pairs. */
  envVars?: ProjectEnvVar[];
}

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'STEP' | 'SUCCESS';

export interface LogLine {
  seq: number;
  level: LogLevel;
  message: string;
  ts: string;
}

export interface BuildDetail {
  id: string;
  status: BuildStatus | string;
  commitSha: string;
  commitMessage: string;
  commitAuthor: string;
  branch: string;
  imageTag: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  errorMessage: string | null;
  createdAt: string;
  project: {
    id: string;
    name: string;
    githubRepoFullName: string;
    liveUrl: string | null;
  };
}

export interface ProjectEnvVar {
  key: string;
  value: string;
}

/** Cursor-paginated list envelope returned by the M5 list endpoints. */
export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
}

/** A row from `GET /api/projects/:id/builds` (richer than `BuildSummary`). */
export interface BuildListItem extends BuildSummary {
  imageTag: string | null;
  errorMessage: string | null;
}

/** The build info embedded in a deployment row. */
export interface DeploymentBuildInfo {
  id: string;
  status: BuildStatus | string;
  commitSha: string;
  commitMessage: string;
  commitAuthor: string;
  branch: string;
  imageTag?: string | null;
}

/** A row from `GET /api/projects/:id/deployments`. */
export interface DeploymentListItem {
  id: string;
  revisionName: string;
  active: boolean;
  rolledBack: boolean;
  createdAt: string;
  build: DeploymentBuildInfo;
}

/** A row from `GET /api/deployments` (cross-project, carries project info). */
export interface CrossProjectDeployment extends DeploymentListItem {
  project: { id: string; name: string; liveUrl: string | null };
}

export type ActivityType =
  | 'build.queued'
  | 'build.succeeded'
  | 'build.failed'
  | 'build.cancelled'
  | 'deployment.created'
  | 'deployment.rollback'
  | 'project.created'
  | 'project.deleted';

export interface ActivityEvent {
  id: string;
  type: ActivityType;
  ts: string;
  projectId: string;
  projectName: string;
  buildId?: string;
  commitSha?: string;
  commitMessage?: string;
  commitAuthor?: string;
}

export interface CreateProjectInput {
  repoUrl: string;
  branch: string;
  name: string;
}

/**
 * A repo from `GET /api/github/repos` — the user's GitHub repositories the
 * New Project picker lists, already sorted most-recently-pushed first by the
 * backend. The endpoint wraps these as `{ repos: GithubRepo[] }`.
 */
export interface GithubRepo {
  fullName: string;
  url: string;
  defaultBranch: string;
  private: boolean;
}

export interface UpdateProjectInput {
  branch?: string;
  name?: string;
  autoDeploy?: boolean;
  envVars?: ProjectEnvVar[] | null;
}

/** A line of the running container's stdout/stderr (`GET …/runtime/logs`). */
export interface RuntimeLogLine {
  ts: string;
  message: string;
  stream: 'stdout' | 'stderr' | 'unknown';
  revision: string | null;
}

/**
 * `GET /api/projects/:id/runtime/logs`. `available:false` (with a `note`) when
 * the log workspace isn't configured or the query failed — the UI shows the
 * note instead of an error.
 */
export interface RuntimeLogsResult {
  lines: RuntimeLogLine[];
  available: boolean;
  note?: string;
}

/** `POST /api/github/detect` — framework preview for the New Project modal. */
export interface DetectFrameworkResult {
  /** The repo ships its own Dockerfile (we build it as-is). */
  hasDockerfile: boolean;
  /** Detected framework label, or null when unrecognized. */
  framework: string | null;
  /** Detected listen port, or null. */
  port: number | null;
}

/**
 * Why a config-only redeploy did or didn't happen after an env-var save
 * (M5 #6). `NO_ACTIVE_DEPLOYMENT` = project never had a successful deploy, so
 * the vars apply on its first build; `BUILD_IN_PROGRESS` = an in-flight build
 * will pick them up; `NO_IMAGE` = the active deployment's build has no pushed
 * image; `REDEPLOY_FAILED` = the vars saved but the Azure roll errored.
 */
export type RedeployReason =
  | 'NO_ACTIVE_DEPLOYMENT'
  | 'BUILD_IN_PROGRESS'
  | 'NO_IMAGE'
  | 'REDEPLOY_FAILED';

export interface RedeploySummary {
  redeployed: boolean;
  reason?: RedeployReason;
}

/**
 * `PATCH /api/projects/:id` response. Extends the project detail with an
 * optional `redeploy` summary, present only when the request included
 * `envVars` (saving env vars auto-redeploys with the last successful image).
 */
export interface UpdateProjectResult extends ProjectDetail {
  redeploy?: RedeploySummary;
}

/** `POST /api/projects/:id/rebuild` response. */
export interface RebuildResult {
  buildId: string;
}

/** `POST /api/builds/:id/cancel` response. */
export interface CancelBuildResult {
  id: string;
  status: BuildStatus | string;
  /** True when cancellation was *requested* of a running build (cooperative). */
  cancelRequested: boolean;
}

/** `GET /api/account`. */
export interface AccountInfo {
  id: string;
  githubLogin: string;
  email: string | null;
  avatarUrl: string | null;
  github: { connected: boolean; scopes: string[] };
  azure: {
    mode: 'managed-identity' | 'stub';
    region: string;
    subscriptionId: string | null;
    resourceGroup: string | null;
  };
  counts: { projects: number };
}

/** `POST /api/account/azure/test`. */
export interface AzureTestResult {
  ok: boolean;
  mode: 'managed-identity' | 'stub';
  detail?: string;
  latencyMs?: number;
}
